import type { CounterStore } from './counter-store.types.js';
import type { GuardReporting } from './guard-reporting.types.js';

/**
 * What a route does when the count cannot be taken. `allow` fails open, for routes where locking
 * every member out is worse than a window with no limit (sign-in); `refuse` fails closed, for a
 * route that opens accounts, redeems invites, sends mail or calls a paid model, where an outage
 * must not become unlimited use.
 */
export type RateLimitStoreOutage = 'allow' | 'refuse';

export type RateLimitPolicy = {
  /** Part of the store key and of every log line, so keep it stable and free of user data. */
  name: string;
  limit: number;
  windowSeconds: number;
  whenStoreUnavailable: RateLimitStoreOutage;
};

export type RateLimitCheck = {
  policy: RateLimitPolicy;
  /**
   * Who is counted, e.g. `ip:<address>` or `user:<id>`; never a raw email. It is logged as is,
   * as `client`, on the first refusal in a window.
   */
  clientId: string;
};

export type TimedRateLimitCheck = RateLimitCheck & {
  /** The clock, in epoch milliseconds; defaults to now. */
  now?: number;
};

export type RateLimitDecision =
  | { isAllowed: true }
  | { isAllowed: false; reason: 'overLimit' | 'storeUnavailable'; retryAfterSeconds: number };

export type RateLimitRefusal = Extract<RateLimitDecision, { isAllowed: false }>;

export type RateLimiterOptions = GuardReporting & {
  store: CounterStore;
  /**
   * Whether a store nobody configured counts as an outage. Defaults to true on the production
   * deployment (`VERCEL_ENV=production`) only; pass true on a host that does not set it.
   */
  requireStore?: boolean;
};

export type RateLimiter = {
  check(request: TimedRateLimitCheck): Promise<RateLimitDecision>;
  /** Takes the counts in order and stops at the first refusal; list the shortest window first. */
  checkAll(request: { checks: RateLimitCheck[]; now?: number }): Promise<RateLimitDecision>;
};
