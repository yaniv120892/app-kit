import type { CounterReading } from './counter-store.types.js';
import { assertPositiveInteger } from './positive-integer.js';
import type {
  RateLimitCheck,
  RateLimitDecision,
  RateLimiter,
  RateLimiterOptions,
  RateLimitPolicy,
  RateLimitRefusal,
  TimedRateLimitCheck,
} from './rate-limit.types.js';
import { secondsUntil } from './seconds-until.js';
import {
  createStoreOutageReporter,
  isProductionDeployment,
  isStoreOutage,
  STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
} from './store-outage.js';
import type { StoreOutageReporter } from './store-outage.types.js';

export type {
  RateLimitCheck,
  RateLimitDecision,
  RateLimiter,
  RateLimiterOptions,
  RateLimitPolicy,
  RateLimitRefusal,
  RateLimitStoreOutage,
  TimedRateLimitCheck,
} from './rate-limit.types.js';

export const RETRY_AFTER_HEADER = 'retry-after';

const STORE_UNAVAILABLE_MESSAGE = 'This is temporarily unavailable. Try again in a minute.';

type UnavailableReading = Extract<CounterReading, { status: 'unavailable' }>;

/**
 * A fixed window per client. When the count cannot be taken, the policy's `whenStoreUnavailable`
 * decides: `allow` lets the request through, `refuse` answers it as unavailable. Either way the
 * outage is logged and alerted at most once per 15 minutes per policy and server instance.
 */
export function createRateLimiter({
  store,
  logger,
  alerts,
  requireStore = isProductionDeployment(),
}: RateLimiterOptions): RateLimiter {
  const reportStoreOutage = createStoreOutageReporter({ logger, alerts });

  async function check({
    policy,
    clientId,
    now = Date.now(),
  }: TimedRateLimitCheck): Promise<RateLimitDecision> {
    assertPolicyNumbers(policy);
    const windowMs = policy.windowSeconds * 1000;
    const windowIndex = Math.floor(now / windowMs);
    const reading = await store.increment({
      key: `rate_limit:${policy.name}:${clientId}:${windowIndex}`,
      ttlSeconds: policy.windowSeconds,
    });

    if (reading.status === 'unavailable') {
      const isOutage = isStoreOutage({ cause: reading.cause, requireStore });
      return isOutage
        ? decideDuringOutage({ policy, reading, now, reportStoreOutage })
        : { isAllowed: true };
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

function decideDuringOutage({
  policy,
  reading,
  now,
  reportStoreOutage,
}: {
  policy: RateLimitPolicy;
  reading: UnavailableReading;
  now: number;
  reportStoreOutage: StoreOutageReporter;
}): RateLimitDecision {
  const fields = { policy: policy.name, cause: reading.cause, detail: reading.detail };
  if (policy.whenStoreUnavailable === 'allow') {
    reportStoreOutage({
      throttleKey: policy.name,
      logMessage: 'rate_limit_allowed_store_unavailable',
      fields,
      alert: {
        alertType: 'rate_limit_store_unavailable_failing_open',
        title: `Allowing ${policy.name} requests without a limit: the rate-limit store is ${reading.cause}`,
      },
      now,
    });
    return { isAllowed: true };
  }
  reportStoreOutage({
    throttleKey: policy.name,
    logMessage: 'rate_limit_refused_store_unavailable',
    fields,
    alert: {
      alertType: 'rate_limit_store_unavailable',
      title: `Refusing ${policy.name} requests: the rate-limit store is ${reading.cause}`,
    },
    now,
  });
  return {
    isAllowed: false,
    reason: 'storeUnavailable',
    retryAfterSeconds: STORE_UNAVAILABLE_RETRY_AFTER_SECONDS,
  };
}

function assertPolicyNumbers(policy: RateLimitPolicy): void {
  assertPositiveInteger({ name: `${policy.name} limit`, value: policy.limit });
  assertPositiveInteger({ name: `${policy.name} windowSeconds`, value: policy.windowSeconds });
}
