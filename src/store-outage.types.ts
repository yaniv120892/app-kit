import type { GuardAlert } from './guard-reporting.types.js';

export type StoreOutageReport = {
  /** What the throttle counts, e.g. a policy or feature name: one report per key per interval. */
  throttleKey: string;
  logMessage: string;
  fields: Record<string, unknown>;
  alert: GuardAlert;
  now: number;
};

export type StoreOutageReporter = (report: StoreOutageReport) => void;
