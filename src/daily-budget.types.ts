import type { CounterStore } from './counter-store.types.js';
import type { GuardReporting } from './guard-reporting.types.js';

export type DailyBudget = {
  /**
   * Lower-case letters, digits and underscores. Names the store keys, the log lines, and the
   * kill switch: `advisor` is turned off by `ADVISOR_ENABLED=false`.
   */
  feature: string;
  /** Uses one subject (a user, a household) may spend per UTC day. */
  subjectLimit: number;
  /** Uses everyone together may spend per UTC day: the cap on what a bad day can cost. */
  globalLimit: number;
};

export type DailyBudgetOptions = GuardReporting & {
  store: CounterStore;
  /**
   * Whether a store nobody configured counts as an outage. Defaults to true on the production
   * deployment (`VERCEL_ENV=production`) only; pass true on a host that does not set it.
   */
  requireStore?: boolean;
};

export type DailyBudgetRequest = {
  budget: DailyBudget;
  subjectId: string;
  now?: number;
};

export type DailyBudgetReservation = DailyBudgetOptions & DailyBudgetRequest;

export type DailyBudgetDecision =
  | { isAllowed: true }
  | { isAllowed: false; reason: 'disabled' }
  | {
      isAllowed: false;
      reason: 'subjectDailyLimit' | 'globalDailyLimit' | 'storeUnavailable';
      retryAfterSeconds: number;
    };

export type DailyBudgets = {
  reserve(request: DailyBudgetRequest): Promise<DailyBudgetDecision>;
};
