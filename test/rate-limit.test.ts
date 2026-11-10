import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRateLimiter,
  rateLimitRefusalResponse,
  refuseIfRateLimited,
} from '../src/rate-limit.js';
import type { RateLimitPolicy } from '../src/rate-limit.types.js';
import { createFakeCounterStore } from './fakes/counter-store.js';
import { createRecordingReporting } from './fakes/reporting.js';

const WINDOW_START = Date.UTC(2026, 10, 10, 12, 0, 0);
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

const FAILED_STORE = { status: 'unavailable', cause: 'failed', detail: 'timed out' } as const;
const UNCONFIGURED_STORE = { status: 'unavailable', cause: 'unconfigured' } as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('createRateLimiter', () => {
  it('allows up to the limit and refuses the next hit until the window ends', async () => {
    const reporting = createRecordingReporting();
    const rateLimiter = createRateLimiter({ store: createFakeCounterStore(), ...reporting });
    const now = WINDOW_START + 15_000;

    const first = await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now });
    const second = await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now });
    const third = await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now });

    expect([first, second]).toEqual([{ isAllowed: true }, { isAllowed: true }]);
    expect(third).toEqual({ isAllowed: false, reason: 'overLimit', retryAfterSeconds: 45 });
  });

  it('counts each window apart, so the next window starts from zero', async () => {
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore(),
      ...createRecordingReporting(),
    });
    for (const _hit of [1, 2, 3]) {
      await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now: WINDOW_START });
    }

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

    for (const _hit of [1, 2, 3, 4, 5]) {
      await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT, now: WINDOW_START });
    }

    expect(reporting.lines).toEqual([
      expect.objectContaining({ level: 'warn', message: 'rate_limit_exceeded' }),
    ]);
  });

  it('refuses with 503 semantics and alerts when a refuse policy cannot count', async () => {
    const reporting = createRecordingReporting();
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore({ failure: FAILED_STORE }),
      ...reporting,
    });

    const decision = await rateLimiter.check({ policy: SIGNUP, clientId: CLIENT });

    expect(decision).toEqual({
      isAllowed: false,
      reason: 'storeUnavailable',
      retryAfterSeconds: 60,
    });
    expect(reporting.scheduledAlerts).toEqual([
      expect.objectContaining({ alertType: 'rate_limit_store_unavailable' }),
    ]);
  });

  it('allows an allow policy through an outage and alerts once per 15 minutes', async () => {
    const reporting = createRecordingReporting();
    const rateLimiter = createRateLimiter({
      store: createFakeCounterStore({ failure: FAILED_STORE }),
      ...reporting,
    });

    const decisions = [
      await rateLimiter.check({ policy: LOGIN, clientId: CLIENT, now: WINDOW_START }),
      await rateLimiter.check({ policy: LOGIN, clientId: CLIENT, now: WINDOW_START + 60_000 }),
      await rateLimiter.check({ policy: LOGIN, clientId: CLIENT, now: WINDOW_START + 900_000 }),
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

  it('stops at the first refusal, so a longer window behind it is not spent', async () => {
    const store = createFakeCounterStore();
    const rateLimiter = createRateLimiter({ store, ...createRecordingReporting() });
    const checks = [
      { policy: SIGNUP, clientId: CLIENT },
      { policy: SIGNUP_DAILY, clientId: CLIENT },
    ];

    for (const _attempt of [1, 2, 3, 4]) {
      await rateLimiter.checkAll({ checks, now: WINDOW_START });
    }

    const dailyKeys = store.incrementedKeys.filter((key) => key.includes(':signup_daily:'));
    expect(dailyKeys).toHaveLength(2);
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
    const request = {
      rateLimiter,
      checks: [{ policy: SIGNUP, clientId: CLIENT }],
      overLimitMessage: 'Slow down.',
    };

    const responses = [
      await refuseIfRateLimited(request),
      await refuseIfRateLimited(request),
      await refuseIfRateLimited(request),
    ];

    expect(responses.slice(0, 2)).toEqual([null, null]);
    expect(responses[2]?.status).toBe(429);
  });
});
