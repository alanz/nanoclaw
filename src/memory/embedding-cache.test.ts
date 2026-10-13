/**
 * The embedding cache neither takes nor serves unusable vectors, and drops
 * rows no chunk uses once they are past a grace window. Live, 2026-10-13: 4,907
 * of 18,781 cache rows were used by no chunk, and nothing ever pruned it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ vector: null as ((text: string) => number[]) | null }));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map((t) => ctl.vector?.(t) ?? new Array(3072).fill(0.01)),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { MemoryIndexManager } from './manager.js';

const DAY = 24 * 60 * 60 * 1000;
let root: string;
let memory: string;
let dbPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cache-')));
  memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  dbPath = path.join(root, 'index.db');
  ctl.vector = null;
  fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<MemoryIndexManager> {
  const m = new MemoryIndexManager('ag-main', 'main', memory, dbPath, 'test-key', 'gemini-embedding-001');
  await m.init();
  await vi.waitFor(() => expect((m as unknown as { _syncing: boolean })._syncing).toBe(false), { timeout: 5000 });
  await (m as unknown as { syncLock: Promise<void> }).syncLock;
  return m;
}

function db<T>(fn: (d: Database.Database) => T): T {
  const d = new Database(dbPath);
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

describe('embedding cache', { timeout: 20_000 }, () => {
  it.each([
    ['short', () => [0.1, 0.2]],
    ['all zeros', () => new Array(3072).fill(0)],
    ['non-finite', () => [Number.NaN, ...new Array(3071).fill(0.01)]],
  ])('a %s vector is neither stored nor cached; the file is retried', async (_kind, bad) => {
    ctl.vector = bad;
    const m = await start();
    expect(db((d) => d.prepare('SELECT COUNT(*) AS n FROM files').get())).toEqual({ n: 0 });
    expect(db((d) => d.prepare('SELECT COUNT(*) AS n FROM embedding_cache').get())).toEqual({ n: 0 });
    expect(m.isDirty).toBe(true);

    ctl.vector = null;
    await m.sync();
    expect(db((d) => d.prepare('SELECT COUNT(*) AS n FROM files').get())).toEqual({ n: 1 });
    await m.close();
  });

  it('rows no chunk uses are pruned once past the grace window; rows in use stay', async () => {
    await (await start()).close();
    const now = Date.now();
    db((d) => {
      d.prepare('UPDATE embedding_cache SET updated_at = ?').run(now - 40 * DAY); // in use, old
      const add = d.prepare(
        `INSERT INTO embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES ('gemini', 'gemini-embedding-001', 'k', ?, '[0.1]', 1, ?)`,
      );
      add.run('unused-old', now - 40 * DAY);
      add.run('unused-recent', now - DAY);
      d.prepare("DELETE FROM meta WHERE key = 'last_cache_prune'").run();
    });

    await (await start()).close();
    const hashes = db((d) =>
      (d.prepare('SELECT hash FROM embedding_cache ORDER BY hash').all() as Array<{ hash: string }>).map((r) => r.hash),
    );
    expect(hashes).not.toContain('unused-old');
    expect(hashes).toContain('unused-recent');
    expect(hashes).toHaveLength(2);
    const last = db((d) => d.prepare("SELECT value FROM meta WHERE key = 'last_cache_prune'").get()) as {
      value: string;
    };
    expect(JSON.parse(last.value)).toMatchObject({ removed: 1 });
  });

  it('the cache is pruned at most once a day outside a full re-index', async () => {
    await (await start()).close();
    db((d) =>
      d
        .prepare(
          `INSERT INTO embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES ('gemini', 'gemini-embedding-001', 'k', 'unused-old', '[0.1]', 1, ?)`,
        )
        .run(Date.now() - 40 * DAY),
    );

    await (await start()).close();
    const left = db((d) => d.prepare("SELECT COUNT(*) AS n FROM embedding_cache WHERE hash = 'unused-old'").get());
    expect(left).toEqual({ n: 1 });
  });
});
