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

export type DailyBudgetReservation = GuardReporting & {
  budget: DailyBudget;
  subjectId: string;
  store: CounterStore;
  now?: number;
};

export type DailyBudgetDecision =
  | { isAllowed: true }
  | { isAllowed: false; reason: 'disabled' }
  | {
      isAllowed: false;
      reason: 'subjectDailyLimit' | 'globalDailyLimit' | 'storeUnavailable';
      retryAfterSeconds: number;
    };
