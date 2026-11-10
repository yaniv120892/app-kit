import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFeatureDisabled, reserveDailyBudget } from '../src/daily-budget.js';
import type { DailyBudget } from '../src/daily-budget.types.js';
import { createFakeCounterStore } from './fakes/counter-store.js';
import { createRecordingReporting } from './fakes/reporting.js';

const NOON_UTC = Date.UTC(2026, 10, 10, 12, 0, 0);
const SECONDS_TO_MIDNIGHT = 12 * 60 * 60;

const ADVISOR: DailyBudget = { feature: 'advisor', subjectLimit: 2, globalLimit: 3 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('reserveDailyBudget', () => {
  it('allows up to the subject limit and refuses until midnight UTC after it', async () => {
    const store = createFakeCounterStore();
    const reporting = createRecordingReporting();
    const reserve = () =>
      reserveDailyBudget({
        budget: ADVISOR,
        subjectId: 'user-1',
        store,
        ...reporting,
        now: NOON_UTC,
      });

    const decisions = [await reserve(), await reserve(), await reserve()];

    expect(decisions).toEqual([
      { isAllowed: true },
      { isAllowed: true },
      { isAllowed: false, reason: 'subjectDailyLimit', retryAfterSeconds: SECONDS_TO_MIDNIGHT },
    ]);
  });

  it('refuses everyone once the global budget is spent, and alerts once', async () => {
    const store = createFakeCounterStore();
    const reporting = createRecordingReporting();
    const reserveFor = (subjectId: string) =>
      reserveDailyBudget({ budget: ADVISOR, subjectId, store, ...reporting, now: NOON_UTC });

    const decisions = [];
    for (const subjectId of ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']) {
      decisions.push(await reserveFor(subjectId));
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
    const reporting = createRecordingReporting();

    for (const _attempt of [1, 2, 3, 4, 5]) {
      await reserveDailyBudget({
        budget: ADVISOR,
        subjectId: 'user-1',
        store,
        ...reporting,
        now: NOON_UTC,
      });
    }

    const globalKey = [...store.counts.keys()].find((key) => key.includes(':global:'));
    expect(store.counts.get(globalKey ?? '')).toBe(2);
  });

  it('starts a new day at midnight UTC', async () => {
    const store = createFakeCounterStore();
    const reporting = createRecordingReporting();
    const reserveAt = (now: number) =>
      reserveDailyBudget({ budget: ADVISOR, subjectId: 'user-1', store, ...reporting, now });
    await reserveAt(NOON_UTC);
    await reserveAt(NOON_UTC);

    const nextDay = await reserveAt(NOON_UTC + SECONDS_TO_MIDNIGHT * 1000);

    expect(nextDay).toEqual({ isAllowed: true });
  });

  it('fails closed when the counter fails', async () => {
    const reporting = createRecordingReporting();

    const decision = await reserveDailyBudget({
      budget: ADVISOR,
      subjectId: 'user-1',
      store: createFakeCounterStore({ failure: { status: 'unavailable', cause: 'failed' } }),
      ...reporting,
    });

    expect(decision).toEqual({
      isAllowed: false,
      reason: 'storeUnavailable',
      retryAfterSeconds: 60,
    });
    expect(reporting.scheduledAlerts).toEqual([
      expect.objectContaining({ alertType: 'advisor_budget_store_unavailable' }),
    ]);
  });

  it('allows when the counter is unconfigured outside production', async () => {
    vi.stubEnv('VERCEL_ENV', 'development');

    const decision = await reserveDailyBudget({
      budget: ADVISOR,
      subjectId: 'user-1',
      store: createFakeCounterStore({ failure: { status: 'unavailable', cause: 'unconfigured' } }),
      ...createRecordingReporting(),
    });

    expect(decision).toEqual({ isAllowed: true });
  });

  it('refuses when the counter is unconfigured on production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');

    const decision = await reserveDailyBudget({
      budget: ADVISOR,
      subjectId: 'user-1',
      store: createFakeCounterStore({ failure: { status: 'unavailable', cause: 'unconfigured' } }),
      ...createRecordingReporting(),
    });

    expect(decision).toMatchObject({ isAllowed: false, reason: 'storeUnavailable' });
  });

  it('refuses without counting while the kill switch is off', async () => {
    vi.stubEnv('ADVISOR_ENABLED', ' False ');
    const store = createFakeCounterStore();

    const decision = await reserveDailyBudget({
      budget: ADVISOR,
      subjectId: 'user-1',
      store,
      ...createRecordingReporting(),
    });

    expect(decision).toEqual({ isAllowed: false, reason: 'disabled' });
    expect(store.incrementedKeys).toEqual([]);
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
