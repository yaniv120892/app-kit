import type { CounterReading, CounterStore } from '../../src/counter-store.types.js';

type FakeCounterStore = CounterStore & {
  counts: Map<string, number>;
  incrementedKeys: string[];
};

/** An in-memory store; pass `failure` to have every increment come back unavailable. */
export function createFakeCounterStore({
  failure,
}: { failure?: Extract<CounterReading, { status: 'unavailable' }> } = {}): FakeCounterStore {
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
