import type {
  DailyBudget,
  DailyBudgetDecision,
  DailyBudgetOptions,
  DailyBudgetRequest,
  DailyBudgetReservation,
  DailyBudgets,
} from './daily-budget.types.js';
import type { GuardReporting } from './guard-reporting.types.js';
import { assertPositiveInteger } from './positive-integer.js';
import { secondsUntil } from './seconds-until.js';
import {
  createStoreOutageReporter,
  isProductionDeployment,
  isStoreOutage,
  STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from './store-outage.js';

export type {
  DailyBudget,
  DailyBudgetDecision,
  DailyBudgetOptions,
  DailyBudgetRequest,
  DailyBudgetReservation,
  DailyBudgets,
} from './daily-budget.types.js';

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;
/** The key outlives its day by one, so a count read near midnight UTC is never cut short. */
const COUNTER_TTL_SECONDS = 2 * DAY_SECONDS;
const DISABLED_VALUE = 'false';
const FEATURE_NAME = /^[a-z][a-z0-9_]*$/;

type BudgetScope = 'subject' | 'global';

type DailyCounter = {
  scope: BudgetScope;
  key: string;
  limit: number;
};

/**
 * Spends one use from the subject's daily allowance and then from the global one, before the paid
 * work starts. The subject's count comes first, so a subject refused for its own limit never
 * spends the global budget. The price of that order: a use the global budget (or a global count
 * that fails) then refuses has still been counted against the subject.
 *
 * Fails closed: each use costs money, so with the counter down (or unconfigured where
 * `requireStore` holds) the feature answers no one, and an outage never becomes an unmetered
 * window. Outages are reported at most once per 15 minutes per feature and server instance.
 */
export function createDailyBudget({
  store,
  logger,
  alerts,
  requireStore = isProductionDeployment(),
}: DailyBudgetOptions): DailyBudgets {
  const reportStoreOutage = createStoreOutageReporter({ logger, alerts });

  async function reserve({
    budget,
    subjectId,
    now = Date.now(),
  }: DailyBudgetRequest): Promise<DailyBudgetDecision> {
    if (isFeatureDisabled(budget.feature)) {
      return { isAllowed: false, reason: 'disabled' };
    }
    assertBudgetLimits(budget);
    const day = Math.floor(now / DAY_MS);
    const retryAfterSeconds = secondsUntil({ endsAt: (day + 1) * DAY_MS, now });
    const counters: DailyCounter[] = [
      {
        scope: 'subject',
        key: `${budget.feature}_budget:subject:${subjectId}:${day}`,
        limit: budget.subjectLimit,
      },
      { scope: 'global', key: `${budget.feature}_budget:global:${day}`, limit: budget.globalLimit },
    ];

    for (const counter of counters) {
      const reading = await store.increment({ key: counter.key, ttlSeconds: COUNTER_TTL_SECONDS });
      if (reading.status === 'unavailable') {
        const isOutage = isStoreOutage({ cause: reading.cause, requireStore });
        if (!isOutage) {
          return { isAllowed: true };
        }
        reportStoreOutage({
          throttleKey: budget.feature,
          logMessage: 'daily_budget_refused_store_unavailable',
          fields: {
            feature: budget.feature,
            scope: counter.scope,
            cause: reading.cause,
            detail: reading.detail,
          },
          alert: {
            alertType: `${budget.feature}_budget_store_unavailable`,
            title: `Refusing ${budget.feature}: its daily budget counter is ${reading.cause}`,
          },
          now,
        });
        return {
          isAllowed: false,
          reason: 'storeUnavailable',
          retryAfterSeconds: STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
        };
      }
      if (reading.hits > counter.limit) {
        const isFirstRefusalToday = reading.hits === counter.limit + 1;
        if (isFirstRefusalToday) {
          reportLimitReached({
            budget,
            counter,
            subjectId,
            retryAfterSeconds,
            reporting: { logger, alerts },
          });
        }
        return {
          isAllowed: false,
          reason: counter.scope === 'subject' ? 'subjectDailyLimit' : 'globalDailyLimit',
          retryAfterSeconds,
        };
      }
    }
    return { isAllowed: true };
  }

  return { reserve };
}

/**
 * One reservation without keeping a `createDailyBudget` around. Prefer the factory in an app: its
 * outage throttle lives as long as it does, while this one forgets it after every call.
 */
export async function reserveDailyBudget({
  budget,
  subjectId,
  now,
  ...options
}: DailyBudgetReservation): Promise<DailyBudgetDecision> {
  return createDailyBudget(options).reserve({ budget, subjectId, now });
}

/** `<FEATURE>_ENABLED=false` turns a feature off without a deploy; anything else leaves it on. */
export function isFeatureDisabled(feature: string): boolean {
  assertFeatureName(feature);
  const switchValue = process.env[`${feature.toUpperCase()}_ENABLED`];
  return switchValue?.trim().toLowerCase() === DISABLED_VALUE;
}

function reportLimitReached({
  budget,
  counter,
  subjectId,
  retryAfterSeconds,
  reporting,
}: {
  budget: DailyBudget;
  counter: DailyCounter;
  subjectId: string;
  retryAfterSeconds: number;
  reporting: GuardReporting;
}): void {
  const fields = { feature: budget.feature, limit: counter.limit, retryAfterSeconds };
  if (counter.scope === 'subject') {
    reporting.logger.warn({ ...fields, subjectId }, 'daily_budget_subject_limit_reached');
    return;
  }
  reporting.logger.error(fields, 'daily_budget_global_limit_reached');
  reporting.alerts.scheduleOpsAlert({
    alertType: `${budget.feature}_global_daily_limit_reached`,
    title: `${budget.feature} reached its daily budget of ${counter.limit} uses and is refusing everyone until 00:00 UTC`,
  });
}

function assertBudgetLimits(budget: DailyBudget): void {
  assertPositiveInteger({ name: `${budget.feature} subjectLimit`, value: budget.subjectLimit });
  assertPositiveInteger({ name: `${budget.feature} globalLimit`, value: budget.globalLimit });
}

function assertFeatureName(feature: string): void {
  if (!FEATURE_NAME.test(feature)) {
    throw new Error(
      `A daily budget feature is lower-case letters, digits and underscores, starting with a letter (feature: ${JSON.stringify(feature)})`,
    );
  }
}
