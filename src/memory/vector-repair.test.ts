/**
 * Vector rows that drifted from the chunks are put right from the stored
 * embeddings, with no embedding calls: orphan vector rows deleted, missing ones
 * written. Live, 2026-10-13: 12,334 orphan rows, all from v1's index.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ embedCalls: 0 }));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => {
      ctl.embedCalls++;
      return texts.map(() => new Array(3072).fill(0.01));
    },
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { MemoryIndexManager } from './manager.js';

const require = createRequire(import.meta.url);
const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };

let root: string;
let memory: string;
let dbPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-repair-')));
  memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  dbPath = path.join(root, 'index.db');
  ctl.embedCalls = 0;
  fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
  fs.writeFileSync(path.join(memory, 'b.md'), '# B\n\nBeta.\n');
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

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const meta = (key: string) =>
  withDb((db) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value);

function vectorIds(): string[] {
  return withDb((db) =>
    (db.prepare('SELECT id FROM chunks_vec_rowids ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id),
  );
}
function chunkIds(): string[] {
  return withDb((db) =>
    (db.prepare('SELECT id FROM chunks ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id),
  );
}

describe('vector repair', { timeout: 20_000 }, () => {
  it('a drifted index is repaired at the next start, from stored embeddings', async () => {
    await (await start()).close();
    expect(meta('vector_state')).toBe('clean');
    const chunks = chunkIds();

    // Drift: an orphan vector (a v1-style id) and a chunk whose vector is gone.
    withDb((db) => {
      db.prepare('INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)').run(
        '../../../Sync/org/old.org:1:5:abc',
        Buffer.from(new Float32Array(3072).buffer),
      );
      db.prepare('DELETE FROM chunks_vec WHERE id = ?').run(chunks[0]);
      db.prepare("UPDATE meta SET value = 'needs_repair' WHERE key = 'vector_state'").run();
    });
    const calls = ctl.embedCalls;

    await (await start()).close();
    expect(vectorIds()).toEqual(chunks);
    expect(meta('vector_state')).toBe('clean');
    expect(JSON.parse(meta('last_vector_repair')!)).toMatchObject({ removed: 1, added: 1, failed: 0 });
    expect(ctl.embedCalls).toBe(calls);
  });

  it('an index never checked is checked once, then left alone', async () => {
    await (await start()).close();
    withDb((db) => {
      db.prepare('INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)').run(
        'memory/2026-03-31.md:1:22:def',
        Buffer.from(new Float32Array(3072).buffer),
      );
      db.prepare("DELETE FROM meta WHERE key IN ('vector_state', 'last_vector_repair')").run();
    });

    await (await start()).close();
    expect(vectorIds()).toEqual(chunkIds());
    expect(meta('vector_state')).toBe('clean');
    const firstRepair = meta('last_vector_repair');

    await (await start()).close();
    expect(meta('last_vector_repair')).toBe(firstRepair);
  });
});
