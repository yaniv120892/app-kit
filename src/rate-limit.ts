import type { CounterStoreFailureCause } from './counter-store.types.js';
import type { GuardReporting } from './guard-reporting.types.js';
import { secondsUntil } from './seconds-until.js';
import { isStoreOutage } from './store-outage.js';
import type {
  RateLimitCheck,
  RateLimitDecision,
  RateLimiter,
  RateLimiterOptions,
  RateLimitPolicy,
  RateLimitRefusal,
} from './rate-limit.types.js';

export type {
  RateLimitCheck,
  RateLimitDecision,
  RateLimiter,
  RateLimiterOptions,
  RateLimitPolicy,
  RateLimitRefusal,
  RateLimitStoreOutage,
} from './rate-limit.types.js';

export const RETRY_AFTER_HEADER = 'retry-after';

const STORE_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;
const FAIL_OPEN_REPORT_INTERVAL_MS = 15 * 60 * 1000;
const STORE_UNAVAILABLE_MESSAGE = 'This is temporarily unavailable. Try again in a minute.';

/**
 * A fixed window per client. When the count cannot be taken, the policy's `whenStoreUnavailable`
 * decides: `allow` lets the request through and alerts at most once per 15 minutes per policy,
 * `refuse` answers it as unavailable and alerts every time (the alerter caps the volume).
 */
export function createRateLimiter({ store, logger, alerts }: RateLimiterOptions): RateLimiter {
  const reporting: GuardReporting = { logger, alerts };
  const failOpenReportedAt = new Map<string, number>();

  async function check({
    policy,
    clientId,
    now = Date.now(),
  }: RateLimitCheck & { now?: number }): Promise<RateLimitDecision> {
    const windowMs = policy.windowSeconds * 1000;
    const windowIndex = Math.floor(now / windowMs);
    const reading = await store.increment({
      key: `rate_limit:${policy.name}:${clientId}:${windowIndex}`,
      ttlSeconds: policy.windowSeconds,
    });

    if (reading.status === 'unavailable') {
      return decideWithoutCount({
        policy,
        cause: reading.cause,
        detail: reading.detail,
        now,
        reporting,
        failOpenReportedAt,
      });
    }
    if (reading.hits <= policy.limit) {
      return { isAllowed: true };
    }

    const retryAfterSeconds = secondsUntil({ endsAt: (windowIndex + 1) * windowMs, now });
    const isFirstRefusalInWindow = reading.hits === policy.limit + 1;
    if (isFirstRefusalInWindow) {
      logger.warn(
        {
          policy: policy.name,
          client: clientId,
          limit: policy.limit,
          windowSeconds: policy.windowSeconds,
          retryAfterSeconds,
        },
        'rate_limit_exceeded',
      );
    }
    return { isAllowed: false, reason: 'overLimit', retryAfterSeconds };
  }

  async function checkAll({
    checks,
    now = Date.now(),
  }: {
    checks: RateLimitCheck[];
    now?: number;
  }): Promise<RateLimitDecision> {
    for (const rateLimitCheck of checks) {
      const decision = await check({ ...rateLimitCheck, now });
      if (!decision.isAllowed) {
        return decision;
      }
    }
    return { isAllowed: true };
  }

  return { check, checkAll };
}

/** 429 for a client over its limit, 503 when the store is down; both carry `Retry-After`. */
export function rateLimitRefusalResponse({
  decision,
  overLimitMessage,
}: {
  decision: RateLimitRefusal;
  overLimitMessage: string;
}): Response {
  const isOverLimit = decision.reason === 'overLimit';
  return Response.json(
    { error: isOverLimit ? overLimitMessage : STORE_UNAVAILABLE_MESSAGE },
    {
      status: isOverLimit ? 429 : 503,
      headers: { [RETRY_AFTER_HEADER]: String(decision.retryAfterSeconds) },
    },
  );
}

/** Spends the request's budgets; null when it may go on, the refusal to answer with when not. */
export async function refuseIfRateLimited({
  rateLimiter,
  checks,
  overLimitMessage,
}: {
  rateLimiter: RateLimiter;
  checks: RateLimitCheck[];
  overLimitMessage: string;
}): Promise<Response | null> {
  const decision = await rateLimiter.checkAll({ checks });
  return decision.isAllowed ? null : rateLimitRefusalResponse({ decision, overLimitMessage });
}

function decideWithoutCount({
  policy,
  cause,
  detail,
  now,
  reporting,
  failOpenReportedAt,
}: {
  policy: RateLimitPolicy;
  cause: CounterStoreFailureCause;
  detail: string | undefined;
  now: number;
  reporting: GuardReporting;
  failOpenReportedAt: Map<string, number>;
}): RateLimitDecision {
  if (!isStoreOutage(cause)) {
    return { isAllowed: true };
  }
  if (policy.whenStoreUnavailable === 'allow') {
    reportFailingOpen({ policy, cause, detail, now, reporting, failOpenReportedAt });
    return { isAllowed: true };
  }

  reporting.logger.error(
    { policy: policy.name, cause, detail },
    'rate_limit_refused_store_unavailable',
  );
  reporting.alerts.scheduleOpsAlert({
    alertType: 'rate_limit_store_unavailable',
    title: `Refusing ${policy.name} requests: the rate-limit store is ${cause}`,
  });
  return {
    isAllowed: false,
    reason: 'storeUnavailable',
    retryAfterSeconds: STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
  };
}

function reportFailingOpen({
  policy,
  cause,
  detail,
  now,
  reporting,
  failOpenReportedAt,
}: {
  policy: RateLimitPolicy;
  cause: CounterStoreFailureCause;
  detail: string | undefined;
  now: number;
  reporting: GuardReporting;
  failOpenReportedAt: Map<string, number>;
}): void {
  const reportedAt = failOpenReportedAt.get(policy.name);
  const isReportedRecently =
    reportedAt !== undefined && now - reportedAt < FAIL_OPEN_REPORT_INTERVAL_MS;
  if (isReportedRecently) {
    return;
  }
  failOpenReportedAt.set(policy.name, now);
  reporting.logger.error(
    { policy: policy.name, cause, detail },
    'rate_limit_allowed_store_unavailable',
  );
  reporting.alerts.scheduleOpsAlert({
    alertType: 'rate_limit_store_unavailable_failing_open',
    title: `Allowing ${policy.name} requests without a limit: the rate-limit store is ${cause}`,
  });
}
