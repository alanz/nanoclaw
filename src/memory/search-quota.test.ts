/**
 * A search's query embedding draws on the shared embedding budget like a
 * sync's batches (specs/memory.allium: RPM, TPM and RPD are one budget per
 * account, shared by every group's syncs and by search query embeddings).
 * Weed check 2026-10-29: the query was charged no tokens, and its 429s were
 * only logged — a daily 429 on a search did not start the 24h stop.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queryError: null as Error | null }));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
    embedQuery: async () => {
      if (h.queryError) throw h.queryError;
      return new Array(3072).fill(0.01);
    },
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { EmbeddingRateLimitError } from './embedding-errors.js';
import { MemoryIndexManager } from './manager.js';

interface Recorded {
  permits: Array<{ requests: number; tokens: number }>;
  depleted: Array<[string, number | null | undefined]>;
}

let root: string;
let m: MemoryIndexManager;
let rec: Recorded;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-quota-')));
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(root, 'memory', 'index.md'), '# Index\n\nAardvarks dig burrows at night.\n');
  m = new MemoryIndexManager('ag-q', 'q', path.join(root, 'memory'), path.join(root, 'index.db'), 'key', 'm');
  await m.init();
  rec = { permits: [], depleted: [] };
  // Installed after init, which sets the shared limiter.
  (m as unknown as { rateLimiter: unknown }).rateLimiter = {
    acquirePermit: async (requests: number, _wait: number, tokens = 0) => {
      rec.permits.push({ requests, tokens });
    },
    depleteQuotaForType: (type: string, retryDelayMs?: number | null) => rec.depleted.push([type, retryDelayMs]),
    rpdResumeInMs: () => 86_400_000,
  };
  await m.sync({ force: true });
  rec.permits.length = 0;
  h.queryError = null;
});

afterEach(async () => {
  await m.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a search query embedding', () => {
  it('is charged its tokens', async () => {
    const result = await m.search('where do aardvarks dig', { embedWaitMs: 1000 });
    expect(result.mode).toBe('hybrid');
    const queryPermit = rec.permits.find((p) => p.requests === 1 && p.tokens > 0);
    expect(queryPermit, `permits: ${JSON.stringify(rec.permits)}`).toBeDefined();
  });

  it('that gets a daily 429 starts the shared 24h stop, and the search falls back to keyword', async () => {
    h.queryError = new EmbeddingRateLimitError('Gemini 429: daily', 'rpd', null);
    const result = await m.search('aardvarks', { embedWaitMs: 1000 });
    expect(result.mode).toBe('keyword');
    expect(rec.depleted.map(([type]) => type)).toEqual(['rpd']);
  });

  it('that gets a per-minute 429 starts the shared cool-down', async () => {
    h.queryError = new EmbeddingRateLimitError('Gemini 429: minute', 'rpm', 30_000);
    await m.search('aardvarks', { embedWaitMs: 1000 });
    expect(rec.depleted).toEqual([['rpm', 30_000]]);
  });
});
