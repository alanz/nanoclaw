/**
 * Gemini embedding calls end: each has a timeout, and an indexing batch is
 * retried after a failure that may pass (5xx, network, timeout). Before, a
 * hung request stalled the sync for good, and one 503 left a file for the
 * next sync.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddingRateLimitError } from './embedding-errors.js';
import { createGeminiEmbeddingProvider } from './embeddings.js';

const fast = { retryBaseDelayMs: 1, retryMaxDelayMs: 2 };
const ok = (values: number[][]) =>
  new Response(JSON.stringify({ embeddings: values.map((v) => ({ values: v })) }), { status: 200 });
const status = (code: number, body = '{}') => new Response(body, { status: code });

function stubFetch(...replies: Array<Response | Error | 'hang'>): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected extra request');
    if (next === 'hang') {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gemini embedding transport', () => {
  it('retries a batch after a 503, and returns its vectors', async () => {
    const fetch = stubFetch(status(503), ok([[3, 4]]));
    const p = createGeminiEmbeddingProvider({ apiKey: 'k', timing: fast });
    expect(await p.embedBatch(['a'])).toEqual([[0.6, 0.8]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives a batch up after three retries of a network error', async () => {
    const fetch = stubFetch(...Array.from({ length: 4 }, () => new TypeError('fetch failed')));
    const p = createGeminiEmbeddingProvider({ apiKey: 'k', timing: fast });
    await expect(p.embedBatch(['a'])).rejects.toThrow(/request failed: fetch failed/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('times a hung batch out, and retries it', async () => {
    const fetch = stubFetch('hang', ok([[1, 0]]));
    const p = createGeminiEmbeddingProvider({ apiKey: 'k', timing: { ...fast, batchTimeoutMs: 20 } });
    expect(await p.embedBatch(['a'])).toEqual([[1, 0]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx, or a 429 (the rate limiter handles those)', async () => {
    stubFetch(status(400, 'bad request'));
    const p = createGeminiEmbeddingProvider({ apiKey: 'k', timing: fast });
    await expect(p.embedBatch(['a'])).rejects.toThrow(/400 bad request/);

    const fetch = stubFetch(status(429, '{}'));
    await expect(p.embedBatch(['a'])).rejects.toBeInstanceOf(EmbeddingRateLimitError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a query times out and is not retried: search falls back to keywords at once', async () => {
    const fetch = stubFetch('hang');
    const p = createGeminiEmbeddingProvider({ apiKey: 'k', timing: { ...fast, queryTimeoutMs: 20 } });
    await expect(p.embedQuery('q')).rejects.toThrow(/timed out after 20 ms/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a vector holding a value that is not a finite number comes back as is, for the caller to refuse', async () => {
    stubFetch(new Response('{"embeddings":[{"values":[1,"NaN"]}]}', { status: 200 }));
    const p = createGeminiEmbeddingProvider({ apiKey: 'k', timing: fast });
    const [vec] = await p.embedBatch(['a']);
    expect(vec?.[1]).toBe('NaN');
  });
});
