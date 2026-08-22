/**
 * A sync stopped by the daily embedding quota must pick itself up again once
 * the stop lifts, 24h later. Live, 2026-10-04: the zettel re-index hit the
 * daily budget and stayed stopped until the host was restarted two days later.
 * This drives a real sync and the real limiter on fake time; the provider
 * refuses the first batch with a daily-quota 429 and accepts everything after.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmbeddingRateLimitError } from './embedding-errors.js';

const calls = vi.hoisted(() => ({ embed: 0 }));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => {
      calls.embed++;
      if (calls.embed === 1) throw new EmbeddingRateLimitError('daily quota', 'rpd', null);
      return texts.map(() => new Array(3072).fill(0.01));
    },
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { MemoryIndexManager } from './manager.js';

const HOUR_MS = 3_600_000;

// The sync does real file I/O between fake-timer waits: step fake time in
// small slices and let the real event loop turn between them.
async function advance(ms: number, until: () => boolean = () => false): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !until()) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(Math.min(1_000, end - Date.now()));
  }
  for (let i = 0; i < 20 && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
}

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rpd-resume-')));
  calls.embed = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('memory sync after a daily quota stop', () => {
  it('resumes on its own 24h later, and a pass during the stop does not extend it', async () => {
    const memory = path.join(root, 'memory');
    fs.mkdirSync(memory);
    fs.writeFileSync(path.join(memory, 'note.md'), '# Note\n\nSomething worth remembering.\n');
    const manager = new MemoryIndexManager(
      'ag-main',
      'main',
      memory,
      path.join(root, 'index.db'),
      'test-key',
      'gemini-embedding-001',
    );
    const db = () => (manager as unknown as { index: { db: import('better-sqlite3').Database } }).index.db;
    const embeddedChunks = () => (db().prepare('SELECT count(*) AS n FROM embedding_cache').get() as { n: number }).n;

    await manager.init();
    await advance(5_000, () => calls.embed === 1);
    await advance(1_000);
    expect(calls.embed).toBe(1);
    expect(embeddedChunks()).toBe(0);

    // A pass while the stop is in force (here: a file change) is refused
    // without reaching the provider, and must not push the stop out.
    vi.setSystemTime(Date.now() + 12 * HOUR_MS);
    fs.appendFileSync(path.join(memory, 'note.md'), 'More.\n');
    void manager.sync({ force: true });
    await advance(5_000);
    expect(calls.embed).toBe(1);

    await vi.advanceTimersByTimeAsync(12 * HOUR_MS - 10_000);
    await advance(20_000, () => embeddedChunks() > 0);
    expect(calls.embed).toBe(2);
    expect(embeddedChunks()).toBeGreaterThan(0);

    await manager.close();
  });
});
