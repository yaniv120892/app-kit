import type { CounterStoreFailureCause } from './counter-store.types.js';
import type { GuardReporting } from './guard-reporting.types.js';
import type { StoreOutageReport, StoreOutageReporter } from './store-outage.types.js';

/** The `Retry-After` a guard answers with while its counter store is down. */
export const STORE_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

const OUTAGE_REPORT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The default for a guard's `requireStore`: on the production deployment a store nobody
 * configured is an outage, while a development server or a preview without one runs unguarded.
 */
export function isProductionDeployment(): boolean {
  return process.env.VERCEL_ENV === 'production';
}

export function isStoreOutage({
  cause,
  requireStore,
}: {
  cause: CounterStoreFailureCause;
  requireStore: boolean;
}): boolean {
  return cause === 'failed' || requireStore;
}

/**
 * Logs and alerts an outage at most once per 15 minutes per `throttleKey`, so a store that is
 * down for every request is one report, not one per request. The memory is per server instance:
 * each new serverless instance reports once.
 */
export function createStoreOutageReporter({ logger, alerts }: GuardReporting): StoreOutageReporter {
  const reportedAt = new Map<string, number>();
  return function reportStoreOutage({
    throttleKey,
    logMessage,
    fields,
    alert,
    now,
  }: StoreOutageReport): void {
    const lastReportedAt = reportedAt.get(throttleKey);
    const isReportedRecently =
      lastReportedAt !== undefined && now - lastReportedAt < OUTAGE_REPORT_INTERVAL_MS;
    if (isReportedRecently) {
      return;
    }
    reportedAt.set(throttleKey, now);
    logger.error(fields, logMessage);
    alerts.scheduleOpsAlert(alert);
  };
}
