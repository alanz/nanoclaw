/**
 * A memory sync must never ask the rate limiter for more tokens than its
 * per-minute bucket can hold. Live, 2026-10-03: indexing the org mount, a
 * file with many uncached chunks asked for ~22k tokens in one batch against
 * a 15k bucket; the limiter could never grant it and the sync stalled (three
 * API calls in ten minutes). This drives a real sync with a limiter that
 * records each request and refuses what the real one never could — without
 * the real one's deliberate half-empty warm-up, so the test does not wait.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requested = vi.hoisted(() => [] as number[]);

vi.mock('./rate-limiter.js', () => ({
  TokenBucketRateLimiter: class {
    async acquirePermit(_requests: number, _maxWait: number, tokens: number): Promise<void> {
      requested.push(tokens);
      if (tokens > 15_000) throw new Error(`Request of ${tokens} tokens can never be granted`);
    }
    depleteQuotaForType(): void {}
  },
}));
vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { MemoryIndexManager } from './manager.js';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-batches-')));
  requested.length = 0;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('memory sync batching', () => {
  it('indexes a file too large for one batch, never asking for more than the bucket holds', async () => {
    const org = path.join(root, 'org');
    fs.mkdirSync(org);
    // 42 chunks, ~16k estimated tokens: over one bucket.
    const lines = Array.from({ length: 950 }, (_, i) => `- item ${i}: ${'lorem ipsum dolor sit amet '.repeat(2)}`);
    fs.writeFileSync(path.join(org, 'big.org'), `* Big\n${lines.join('\n')}\n`);
    fs.mkdirSync(path.join(root, 'memory'));
    const manager = new MemoryIndexManager(
      'ag-main',
      'main',
      path.join(root, 'memory'),
      path.join(root, 'index.db'),
      'test-key',
      'gemini-embedding-001',
      [{ dir: org, source: 'org', pathPrefix: 'extra/org' }],
    );
    await manager.init();
    await manager.sync({ force: true });

    expect(requested.length).toBeGreaterThan(1);
    expect(Math.max(...requested)).toBeLessThanOrEqual(15_000);
    const db = (manager as unknown as { index: { db: import('better-sqlite3').Database } }).index.db;
    expect(
      (db.prepare("SELECT count(*) AS n FROM chunks WHERE path = 'extra/org/big.org'").get() as { n: number }).n,
    ).toBe(42);
    await manager.close();
  });
});
