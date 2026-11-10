import type { CounterStoreFailureCause } from './counter-store.types.js';

/**
 * A store nobody configured is an outage only on the production deployment, so a development
 * server or a preview without one runs unguarded instead of refusing everything.
 */
export function isStoreOutage(cause: CounterStoreFailureCause): boolean {
  return cause === 'failed' || process.env.VERCEL_ENV === 'production';
}
