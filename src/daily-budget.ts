import type { CounterStore, CounterStoreFailureCause } from './counter-store.types.js';
import type {
  DailyBudget,
  DailyBudgetDecision,
  DailyBudgetReservation,
} from './daily-budget.types.js';
import type { GuardReporting } from './guard-reporting.types.js';
import { secondsUntil } from './seconds-until.js';
import { isStoreOutage } from './store-outage.js';

export type {
  DailyBudget,
  DailyBudgetDecision,
  DailyBudgetReservation,
} from './daily-budget.types.js';

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;
/** The key outlives its day by one, so a count read near midnight UTC is never cut short. */
const COUNTER_TTL_SECONDS = 2 * DAY_SECONDS;
const STORE_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;
const DISABLED_VALUE = 'false';
const FEATURE_NAME = /^[a-z][a-z0-9_]*$/;

type BudgetScope = 'subject' | 'global';

type DailyCounter = {
  scope: BudgetScope;
  key: string;
  limit: number;
};

type SpendOutcome =
  | { status: 'spent' }
  | { status: 'overLimit'; isFirstRefusalToday: boolean }
  | { status: 'unreadable'; cause: CounterStoreFailureCause; detail: string | undefined };

/**
 * Spends one use from the subject's daily allowance and then from the global one, before the paid
 * work starts. The subject's count comes first, so a subject refused for its own limit never
 * spends the global budget.
 *
 * Fails closed: each use costs money, so with the counter down (or unconfigured on the production
 * deployment) the feature answers no one, and an outage never becomes an unmetered window.
 */
export async function reserveDailyBudget({
  budget,
  subjectId,
  store,
  logger,
  alerts,
  now = Date.now(),
}: DailyBudgetReservation): Promise<DailyBudgetDecision> {
  if (isFeatureDisabled(budget.feature)) {
    return { isAllowed: false, reason: 'disabled' };
  }
  const reporting: GuardReporting = { logger, alerts };
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
    const outcome = await spendOne({ store, counter });
    switch (outcome.status) {
      case 'spent':
        break;
      case 'overLimit':
        if (outcome.isFirstRefusalToday) {
          reportLimitReached({ budget, counter, subjectId, retryAfterSeconds, reporting });
        }
        return {
          isAllowed: false,
          reason: counter.scope === 'subject' ? 'subjectDailyLimit' : 'globalDailyLimit',
          retryAfterSeconds,
        };
      case 'unreadable':
        if (!isStoreOutage(outcome.cause)) {
          return { isAllowed: true };
        }
        reportUnreadableCounter({ budget, scope: counter.scope, outcome, reporting });
        return {
          isAllowed: false,
          reason: 'storeUnavailable',
          retryAfterSeconds: STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
        };
      default:
        return assertNever(outcome);
    }
  }
  return { isAllowed: true };
}

/** `<FEATURE>_ENABLED=false` turns a feature off without a deploy; anything else leaves it on. */
export function isFeatureDisabled(feature: string): boolean {
  assertFeatureName(feature);
  const switchValue = process.env[`${feature.toUpperCase()}_ENABLED`];
  return switchValue?.trim().toLowerCase() === DISABLED_VALUE;
}

async function spendOne({
  store,
  counter,
}: {
  store: CounterStore;
  counter: DailyCounter;
}): Promise<SpendOutcome> {
  const reading = await store.increment({ key: counter.key, ttlSeconds: COUNTER_TTL_SECONDS });
  if (reading.status === 'unavailable') {
    return { status: 'unreadable', cause: reading.cause, detail: reading.detail };
  }
  if (reading.hits <= counter.limit) {
    return { status: 'spent' };
  }
  return { status: 'overLimit', isFirstRefusalToday: reading.hits === counter.limit + 1 };
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

function reportUnreadableCounter({
  budget,
  scope,
  outcome,
  reporting,
}: {
  budget: DailyBudget;
  scope: BudgetScope;
  outcome: Extract<SpendOutcome, { status: 'unreadable' }>;
  reporting: GuardReporting;
}): void {
  reporting.logger.error(
    { feature: budget.feature, scope, cause: outcome.cause, detail: outcome.detail },
    'daily_budget_refused_store_unavailable',
  );
  reporting.alerts.scheduleOpsAlert({
    alertType: `${budget.feature}_budget_store_unavailable`,
    title: `Refusing ${budget.feature}: its daily budget counter is ${outcome.cause}`,
  });
}

function assertFeatureName(feature: string): void {
  if (!FEATURE_NAME.test(feature)) {
    throw new Error(
      `A daily budget feature is lower-case letters, digits and underscores, starting with a letter (feature: ${JSON.stringify(feature)})`,
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled daily budget outcome: ${JSON.stringify(value)}`);
}
