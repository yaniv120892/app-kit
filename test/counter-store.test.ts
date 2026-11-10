import { describe, expect, it, vi } from 'vitest';
import { createUpstashCounterStore } from '../src/counter-store.js';

const URL_SET = 'https://example-store.upstash.io/';
const TOKEN_SET = 'test-token';
const KEY = 'rate_limit:signup:ip:203.0.113.7:42';

function replyWith(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe('createUpstashCounterStore', () => {
  it.each([
    ['url', { url: '', token: TOKEN_SET }],
    ['token', { url: URL_SET, token: undefined }],
  ])(
    'reads as unconfigured without calling out when the %s is unset',
    async (_missing, settings) => {
      const fetchSpy = replyWith([{ result: 1 }, { result: 1 }]);
      const store = createUpstashCounterStore({ ...settings, fetch: fetchSpy });

      const reading = await store.increment({ key: KEY, ttlSeconds: 60 });

      expect(reading).toEqual({ status: 'unavailable', cause: 'unconfigured' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('increments and sets the expiry in one transaction', async () => {
    const fetchSpy = replyWith([{ result: 3 }, { result: 1 }]);
    const store = createUpstashCounterStore({ url: URL_SET, token: TOKEN_SET, fetch: fetchSpy });

    const reading = await store.increment({ key: KEY, ttlSeconds: 60 });

    expect(reading).toEqual({ status: 'counted', hits: 3 });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://example-store.upstash.io/multi-exec');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN_SET}`);
    expect(JSON.parse(String(init?.body))).toEqual([
      ['INCR', KEY],
      ['EXPIRE', KEY, '60'],
    ]);
  });

  it('reads a non-2xx reply as failed, once, with no retry', async () => {
    const fetchSpy = replyWith({ error: `ERR wrong type, command was: ${KEY}` }, 500);
    const store = createUpstashCounterStore({ url: URL_SET, token: TOKEN_SET, fetch: fetchSpy });

    const reading = await store.increment({ key: KEY, ttlSeconds: 60 });

    expect(reading).toEqual({ status: 'unavailable', cause: 'failed', detail: 'HTTP 500' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reads a reply of the wrong shape as failed', async () => {
    const store = createUpstashCounterStore({
      url: URL_SET,
      token: TOKEN_SET,
      fetch: replyWith({ result: 'OK' }),
    });

    const reading = await store.increment({ key: KEY, ttlSeconds: 60 });

    expect(reading).toMatchObject({ status: 'unavailable', cause: 'failed' });
  });

  it('gives up after the timeout instead of waiting on a hung store', async () => {
    const hangingFetch = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const store = createUpstashCounterStore({
      url: URL_SET,
      token: TOKEN_SET,
      timeoutMs: 20,
      fetch: hangingFetch,
    });

    const reading = await store.increment({ key: KEY, ttlSeconds: 60 });

    expect(reading).toEqual({ status: 'unavailable', cause: 'failed', detail: 'timed out' });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('defaults to a one-second timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const store = createUpstashCounterStore({
      url: URL_SET,
      token: TOKEN_SET,
      fetch: replyWith([{ result: 1 }, { result: 1 }]),
    });

    await store.increment({ key: KEY, ttlSeconds: 60 });

    expect(timeoutSpy).toHaveBeenCalledWith(1000);
    timeoutSpy.mockRestore();
  });

  it('keeps the key out of the failure detail', async () => {
    const store = createUpstashCounterStore({
      url: URL_SET,
      token: TOKEN_SET,
      fetch: vi.fn<typeof fetch>(async () => {
        throw new TypeError(`fetch failed for ${KEY}`);
      }),
    });

    const reading = await store.increment({ key: KEY, ttlSeconds: 60 });

    expect(reading).toEqual({ status: 'unavailable', cause: 'failed', detail: 'TypeError' });
  });
});
