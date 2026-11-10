import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDailyBudget, isFeatureDisabled, reserveDailyBudget } from '../src/daily-budget.js';
import type { DailyBudget } from '../src/daily-budget.types.js';
import {
  createFakeCounterStore,
  FAILED_STORE,
  repeatInSequence,
  UNCONFIGURED_STORE,
} from './fakes/counter-store.js';
import { createRecordingReporting } from './fakes/reporting.js';

const NOON_UTC = Date.UTC(2026, 10, 10, 12, 0, 0);
const SECONDS_TO_MIDNIGHT = 12 * 60 * 60;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

const ADVISOR: DailyBudget = { feature: 'advisor', subjectLimit: 2, globalLimit: 3 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createDailyBudget', () => {
  it('allows up to the subject limit and refuses until midnight UTC after it', async () => {
    const dailyBudget = createDailyBudget({
      store: createFakeCounterStore(),
      ...createRecordingReporting(),
    });

    const decisions = await repeatInSequence({
      times: 3,
      attempt: () => dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1', now: NOON_UTC }),
    });

    expect(decisions).toEqual([
      { isAllowed: true },
      { isAllowed: true },
      { isAllowed: false, reason: 'subjectDailyLimit', retryAfterSeconds: SECONDS_TO_MIDNIGHT },
    ]);
  });

  it('refuses everyone once the global budget is spent, and alerts once', async () => {
    const reporting = createRecordingReporting();
    const dailyBudget = createDailyBudget({ store: createFakeCounterStore(), ...reporting });

    const decisions = [];
    for (const subjectId of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']) {
      decisions.push(await dailyBudget.reserve({ budget: ADVISOR, subjectId, now: NOON_UTC }));
    }

    expect(decisions.map((decision) => decision.isAllowed)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(decisions[3]).toMatchObject({ reason: 'globalDailyLimit' });
    expect(reporting.scheduledAlerts).toEqual([
      expect.objectContaining({ alertType: 'advisor_global_daily_limit_reached' }),
    ]);
  });

  it('does not spend the global budget for a subject refused on its own limit', async () => {
    const store = createFakeCounterStore();
    const dailyBudget = createDailyBudget({ store, ...createRecordingReporting() });

    await repeatInSequence({
      times: 5,
      attempt: () => dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1', now: NOON_UTC }),
    });

    const globalKey = [...store.counts.keys()].find((key) => key.includes(':global:'));
    expect(store.counts.get(globalKey ?? '')).toBe(2);
  });

  it('starts a new day at midnight UTC', async () => {
    const dailyBudget = createDailyBudget({
      store: createFakeCounterStore(),
      ...createRecordingReporting(),
    });
    const reserveAt = (now: number) =>
      dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1', now });
    await reserveAt(NOON_UTC);
    await reserveAt(NOON_UTC);

    const nextDay = await reserveAt(NOON_UTC + SECONDS_TO_MIDNIGHT * 1000);

    expect(nextDay).toEqual({ isAllowed: true });
  });

  it('fails closed when the counter fails, alerting once per 15 minutes', async () => {
    const reporting = createRecordingReporting();
    const dailyBudget = createDailyBudget({
      store: createFakeCounterStore({ failure: FAILED_STORE }),
      ...reporting,
    });
    const reserveAt = (now: number) =>
      dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1', now });

    const decisions = [
      await reserveAt(NOON_UTC),
      await reserveAt(NOON_UTC + 60_000),
      await reserveAt(NOON_UTC + FIFTEEN_MINUTES_MS),
    ];

    expect(decisions).toEqual(
      Array(3).fill({ isAllowed: false, reason: 'storeUnavailable', retryAfterSeconds: 60 }),
    );
    expect(reporting.scheduledAlerts.map((alert) => alert.alertType)).toEqual([
      'advisor_budget_store_unavailable',
      'advisor_budget_store_unavailable',
    ]);
  });

  it('allows when the counter is unconfigured outside production', async () => {
    vi.stubEnv('VERCEL_ENV', 'development');
    const dailyBudget = createDailyBudget({
      store: createFakeCounterStore({ failure: UNCONFIGURED_STORE }),
      ...createRecordingReporting(),
    });

    const decision = await dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1' });

    expect(decision).toEqual({ isAllowed: true });
  });

  it('refuses when the counter is unconfigured on production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const dailyBudget = createDailyBudget({
      store: createFakeCounterStore({ failure: UNCONFIGURED_STORE }),
      ...createRecordingReporting(),
    });

    const decision = await dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1' });

    expect(decision).toMatchObject({ isAllowed: false, reason: 'storeUnavailable' });
  });

  it.each([
    [true, 'preview', false],
    [false, 'production', true],
  ])(
    'lets requireStore=%s override VERCEL_ENV=%s (allowed: %s)',
    async (requireStore, vercelEnv, isAllowed) => {
      vi.stubEnv('VERCEL_ENV', vercelEnv);
      const dailyBudget = createDailyBudget({
        store: createFakeCounterStore({ failure: UNCONFIGURED_STORE }),
        requireStore,
        ...createRecordingReporting(),
      });

      const decision = await dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1' });

      expect(decision.isAllowed).toBe(isAllowed);
    },
  );

  it('refuses without counting while the kill switch is off', async () => {
    vi.stubEnv('ADVISOR_ENABLED', ' False ');
    const store = createFakeCounterStore();
    const dailyBudget = createDailyBudget({ store, ...createRecordingReporting() });

    const decision = await dailyBudget.reserve({ budget: ADVISOR, subjectId: 'user-1' });

    expect(decision).toEqual({ isAllowed: false, reason: 'disabled' });
    expect(store.incrementedKeys).toEqual([]);
  });

  it.each([
    ['a global limit of NaN', { globalLimit: Number.NaN }],
    ['a subject limit of zero', { subjectLimit: 0 }],
  ])('throws on %s instead of refusing everyone', async (_case, override) => {
    const store = createFakeCounterStore();
    const dailyBudget = createDailyBudget({ store, ...createRecordingReporting() });

    await expect(
      dailyBudget.reserve({ budget: { ...ADVISOR, ...override }, subjectId: 'user-1' }),
    ).rejects.toThrow(/advisor/);
    expect(store.incrementedKeys).toEqual([]);
  });
});

describe('reserveDailyBudget', () => {
  it('reserves through a one-off budget', async () => {
    const store = createFakeCounterStore();

    const decision = await reserveDailyBudget({
      budget: ADVISOR,
      subjectId: 'user-1',
      store,
      ...createRecordingReporting(),
    });

    expect(decision).toEqual({ isAllowed: true });
    expect(store.incrementedKeys).toHaveLength(2);
  });
});

describe('isFeatureDisabled', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['true', false],
    ['0', false],
    ['false', true],
    ['FALSE', true],
  ])('reads ADVISOR_ENABLED=%j as disabled: %s', (value, isDisabled) => {
    vi.stubEnv('ADVISOR_ENABLED', value);

    expect(isFeatureDisabled('advisor')).toBe(isDisabled);
  });

  it('rejects a feature name that cannot form an environment variable', () => {
    expect(() => isFeatureDisabled('recipe-import')).toThrow(/recipe-import/);
  });
});
