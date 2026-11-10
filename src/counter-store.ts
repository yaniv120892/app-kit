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
/** Redis answers EXPIRE with 1 when it set the timeout. */
const EXPIRE_APPLIED = 1;

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

/**
 * The count, once both commands report success: an EXPIRE that failed would leave a key that
 * never expires, so it is a failed count too. The detail names the status or the step only, never
 * the command, which carries the key.
 */
async function readIncrementReply(response: Response): Promise<CounterReading> {
  if (!response.ok) {
    await response.body?.cancel();
    return { status: 'unavailable', cause: 'failed', detail: `HTTP ${response.status}` };
  }
  const reply: unknown = await response.json();
  const [incrementResult, expireResult] = Array.isArray(reply) ? reply.map(resultOf) : [];
  const isCount = typeof incrementResult === 'number' && Number.isInteger(incrementResult);
  if (!isCount) {
    return { status: 'unavailable', cause: 'failed', detail: 'INCR did not return a count' };
  }
  if (expireResult !== EXPIRE_APPLIED) {
    return { status: 'unavailable', cause: 'failed', detail: 'EXPIRE was not applied' };
  }
  return { status: 'counted', hits: incrementResult };
}

function resultOf(entry: unknown): unknown {
  return typeof entry === 'object' && entry !== null && 'result' in entry ? entry.result : null;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timed out' : error.name;
  }
  return 'non-error thrown';
}
