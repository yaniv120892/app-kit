import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRateLimiter,
  rateLimitRefusalResponse,
  refuseIfRateLimited,
} from '../src/rate-limit.js';
import type { RateLimitPolicy } from '../src/rate-limit.types.js';
import {
  createFakeCounterStore,
  FAILED_STORE,
  repeatInSequence,
  UNCONFIGURED_STORE,
} from './fakes/counter-store.js';
import { createRecordingReporting } from './fakes/reporting.js';

const WINDOW_START = Date.UTC(2026, 10, 10, 12, 0, 0);
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const CLIENT = 'ip:203.0.113.7';

const LOGIN: RateLimitPolicy = {
  name: 'login',
  limit: 2,
  windowSeconds: 60,
  whenStoreUnavailable: 'allow',
};

const SIGNUP: RateLimitPolicy = {
  name: 'signup',
  limit: 2,
  windowSeconds: 60,
  whenStoreUnavailable: 'refuse',
};

const SIGNUP_DAILY: RateLimitPolicy = {
  name: 'signup_daily',
  limit: 10,
  windowSeconds: 24 * 60 * 60,
  whenStoreUnavailable: 'refuse',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('createRateLimiter', () => {
  it('allows up to the limit and refuses the next hit until the window ends', async () => {
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore(),
      ...createRecordingReporting(),
    });

    const decisions = await repeatInSequence({
      times: 3,
      attempt: () =>
        rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now: WINDOW_START + 15_000 }),
    });

    expect(decisions).toEqual([
      { isAllowed: true },
      { isAllowed: true },
      { isAllowed: false, reason: 'overLimit', retryAfterSeconds: 45 },
    ]);
  });

  it('counts each window apart, so the next window starts from zero', async () => {
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore(),
      ...createRecordingReporting(),
    });
    await repeatInSequence({
      times: 3,
      attempt: () => rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now: WINDOW_START }),
    });

    const nextWindow = await rateLimiter.check({
      policy: SIGNUP,
      clientId: CLIENT,
      now: WINDOW_START + 60_000,
    });

    expect(nextWindow).toEqual({ isAllowed: true });
  });

  it('logs the first refusal in a window only', async () => {
    const reporting = createRecordingReporting();
    const rateLimiter = createRateLimiter({ store: createFakeCounterStore(), ...reporting });

    await repeatInSequence({
      times: 5,
      attempt: () => rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now: WINDOW_START }),
    });

    expect(reporting.lines).toEqual([
      expect.objectContaining({ level: 'warn', message: 'rate_limit_exceeded' }),
    ]);
  });

  it('refuses when a refuse policy cannot count, alerting once per 15 minutes', async () => {
    const reporting = createRecordingReporting();
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore({ failure: FAILED_STORE }),
      ...reporting,
    });

    const decisions = [
      await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now: WINDOW_START }),
      await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now: WINDOW_START + 60_000 }),
      await rateLimiter.check({
        policy: SIGNUP,
        clientId: CLIENT,
        now: WINDOW_START + FIFTEEN_MINUTES_MS,
      }),
    ];

    expect(decisions).toEqual(
      Array(3).fill({ isAllowed: false, reason: 'storeUnavailable', retryAfterSeconds: 60 }),
    );
    expect(reporting.scheduledAlerts.map((alert) => alert.alertType)).toEqual([
      'rate_limit_store_unavailable',
      'rate_limit_store_unavailable',
    ]);
    expect(reporting.lines).toHaveLength(2);
  });

  it('allows an allow policy through an outage, alerting once per 15 minutes', async () => {
    const reporting = createRecordingReporting();
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore({ failure: FAILED_STORE }),
      ...reporting,
    });

    const decisions = [
      await rateLimiter.check({ policy: LOGIN, clientId: CLIENT, now: WINDOW_START }),
      await rateLimiter.check({ policy: LOGIN, clientId: CLIENT, now: WINDOW_START + 60_000 }),
      await rateLimiter.check({
        policy: LOGIN,
        clientId: CLIENT,
        now: WINDOW_START + FIFTEEN_MINUTES_MS,
      }),
    ];

    expect(decisions).toEqual([{ isAllowed: true }, { isAllowed: true }, { isAllowed: true }]);
    expect(reporting.scheduledAlerts.map((alert) => alert.alertType)).toEqual([
      'rate_limit_store_unavailable_failing_open',
      'rate_limit_store_unavailable_failing_open',
    ]);
  });

  it('allows silently when the store is unconfigured outside production', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const reporting = createRecordingReporting();
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore({ failure: UNCONFIGURED_STORE }),
      ...reporting,
    });

    const decision = await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT });

    expect(decision).toEqual({ isAllowed: true });
    expect(reporting.scheduledAlerts).toEqual([]);
  });

  it('treats an unconfigured store on production as an outage', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore({ failure: UNCONFIGURED_STORE }),
      ...createRecordingReporting(),
    });

    const decision = await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT });

    expect(decision).toMatchObject({ isAllowed: false, reason: 'storeUnavailable' });
  });

  it.each([
    [true, 'preview', false],
    [false, 'production', true],
  ])(
    'lets requireStore=%s override VERCEL_ENV=%s (allowed: %s)',
    async (requireStore, vercelEnv, isAllowed) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv);
      const rateLimiter = createRateLimiter({
        store: createFakeCounterStore({ failure: UNCONFIGURED_STORE }),
        requireStore,
        ...createRecordingReporting(),
      });

      const decision = await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT });

      expect(decision.isAllowed).toBe(isAllowed);
    },
  );

  it('stops at the first refusal, so a longer window behind it is not spent', async () => {
    const store = createFakeCounterStore();
    const rateLimiter = createRateLimiter({ store, ...createRecordingReporting() });
    const checks = [
      { policy: SIGNUP, clientId: CLIENT },
      { policy: SIGNUP_DAILY, clientId: CLIENT },
    ];

    await repeatInSequence({
      times: 4,
      attempt: () => rateLimiter.checkAll({ checks, now: WINDOW_START }),
    });

    const dailyKeys = store.incrementedKeys.filter((key) => key.includes(':signup_daily:'));
    expect(dailyKeys).toHaveLength(2);
  });

  it.each([
    ['a limit of NaN', { limit: Number.NaN }],
    ['a limit of zero', { limit: 0 }],
    ['a window of zero', { windowSeconds: 0 }],
    ['a fractional window', { windowSeconds: 1.5 }],
  ])('throws on %s instead of refusing everyone', async (_case, override) => {
    const store = createFakeCounterStore();
    const rateLimiter = createRateLimiter({ store, ...createRecordingReporting() });

    await expect(
      rateLimiter.check({ policy: { ...SIGNUP, ...override }, clientId: CLIENT }),
    ).rejects.toThrow(/signup/);
    expect(store.incrementedKeys).toEqual([]);
  });
});

describe('rateLimitRefusalResponse', () => {
  it('answers over-limit with 429 and the caller message', async () => {
    const response = rateLimitRefusalResponse({
      decision: { isAllowed: false, reason: 'overLimit', retryAfterSeconds: 30 },
      overLimitMessage: 'Too many sign-ins. Try again shortly.',
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(await response.json()).toEqual({ error: 'Too many sign-ins. Try again shortly.' });
  });

  it('answers a store outage with 503', () => {
    const response = rateLimitRefusalResponse({
      decision: { isAllowed: false, reason: 'storeUnavailable', retryAfterSeconds: 60 },
      overLimitMessage: 'unused',
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
  });
});

describe('refuseIfRateLimited', () => {
  it('returns null while allowed and the refusal once over the limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: WINDOW_START });
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore(),
      ...createRecordingReporting(),
    });

    const responses = await repeatInSequence({
      times: 3,
      attempt: () =>
        refuseIfRateLimited({
          rateLimiter,
          checks: [{ policy: SIGNUP, clientId: CLIENT }],
          overLimitMessage: 'Slow down.',
        }),
    });

    expect(responses.slice(0, 2)).toEqual([null, null]);
    expect(responses[2]?.status).toBe(429);
  });
});
