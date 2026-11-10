import type { CounterReading, CounterStore } from '../../src/counter-store.types.js';

type UnavailableReading = Extract<CounterReading, { status: 'unavailable' }>;

type FakeCounterStore = CounterStore & {
  counts: Map<string, number>;
  incrementedKeys: string[];
};

export const FAILED_STORE: UnavailableReading = {
  status: 'unavailable',
  cause: 'failed',
  detail: 'timed out',
};

export const UNCONFIGURED_STORE: UnavailableReading = {
  status: 'unavailable',
  cause: 'unconfigured',
};

/** An in-memory store; pass `failure` to have every increment come back unavailable. */
export function createFakeCounterStore({
  failure,
}: { failure?: UnavailableReading } = {}): FakeCounterStore {
  const counts = new Map<string, number>();
  const incrementedKeys: string[] = [];
  return {
    counts,
    incrementedKeys,
    async increment({ key }) {
      incrementedKeys.push(key);
      if (failure) {
        return failure;
      }
      const hits = (counts.get(key) ?? 0) + 1;
      counts.set(key, hits);
      return { status: 'counted', hits };
    },
  };
}

/** Runs `attempt` `times` times in sequence and returns every result in order. */
export async function repeatInSequence<Result>({
  times,
  attempt,
}: {
  times: number;
  attempt: () => Promise<Result>;
}): Promise<Result[]> {
  const results: Result[] = [];
  for (let index = 0; index < times; index++) {
    results.push(await attempt());
  }
  return results;
}
