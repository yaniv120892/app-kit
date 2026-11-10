export type CounterStoreFailureCause = 'unconfigured' | 'failed';

export type CounterReading =
  | { status: 'counted'; hits: number }
  | { status: 'unavailable'; cause: CounterStoreFailureCause; detail?: string };

export type CounterIncrement = {
  key: string;
  ttlSeconds: number;
};

/** Adds one hit to `key` and returns the new total; the key expires `ttlSeconds` after the hit. */
export type CounterStore = {
  increment(request: CounterIncrement): Promise<CounterReading>;
};

export type UpstashCounterStoreOptions = {
  /** `UPSTASH_REDIS_REST_URL`; empty or unset makes every reading `unconfigured`. */
  url: string | undefined;
  /** `UPSTASH_REDIS_REST_TOKEN`; empty or unset makes every reading `unconfigured`. */
  token: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
};
