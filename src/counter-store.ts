import type {
  CounterIncrement,
  CounterReading,
  CounterStore,
  UpstashCounterStoreOptions,
} from './counter-store.types.js';

export type {
  CounterIncrement,
  CounterReading,
  CounterStore,
  CounterStoreFailureCause,
  UpstashCounterStoreOptions,
} from './counter-store.types.js';

/** A count sits in front of every guarded request, so a slow store is an outage, not a wait. */
const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Counts over the Upstash REST API with one `multi-exec` call, so the increment and its expiry
 * land together. No retry: the caller's policy decides what a failed count means, and a retry
 * would only stretch the time the request waits for that decision.
 */
export function createUpstashCounterStore({
  url,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetch: fetchImplementation = fetch,
}: UpstashCounterStoreOptions): CounterStore {
  const baseUrl = url?.trim().replace(/\/+$/, '') ?? '';
  const bearerToken = token?.trim() ?? '';
  const isConfigured = baseUrl !== '' && bearerToken !== '';

  return {
    async increment({ key, ttlSeconds }: CounterIncrement): Promise<CounterReading> {
      if (!isConfigured) {
        return { status: 'unavailable', cause: 'unconfigured' };
      }
      try {
        const response = await fetchImplementation(`${baseUrl}/multi-exec`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
          body: JSON.stringify([
            ['INCR', key],
            ['EXPIRE', key, String(ttlSeconds)],
          ]),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return await readIncrementReply(response);
      } catch (error) {
        return { status: 'unavailable', cause: 'failed', detail: describeFailure(error) };
      }
    },
  };
}

/** The detail names the status or error only, never the command, which carries the key. */
async function readIncrementReply(response: Response): Promise<CounterReading> {
  if (!response.ok) {
    return { status: 'unavailable', cause: 'failed', detail: `HTTP ${response.status}` };
  }
  const reply: unknown = await response.json();
  const hits = firstResult(reply);
  if (hits === null) {
    return { status: 'unavailable', cause: 'failed', detail: 'unexpected reply shape' };
  }
  return { status: 'counted', hits };
}

function firstResult(reply: unknown): number | null {
  if (!Array.isArray(reply)) {
    return null;
  }
  const [first]: unknown[] = reply;
  if (typeof first !== 'object' || first === null || !('result' in first)) {
    return null;
  }
  const { result } = first;
  return typeof result === 'number' && Number.isInteger(result) ? result : null;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timed out' : error.name;
  }
  return 'non-error thrown';
}
