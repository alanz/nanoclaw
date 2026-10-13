/**
 * A host start re-indexes everything only when the settings that shape the
 * index changed. Forcing a full pass on every start rewrote all of index.db
 * (~13.8k chunk rows, ~1.6 GB of borg delta per restart) with nothing changed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ fail: false }));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => {
      if (ctl.fail) throw new Error('embedding service down');
      return texts.map(() => new Array(3072).fill(0.01));
    },
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { MemoryIndexManager } from './manager.js';

let root: string;
let memory: string;
let notes: string;
let dbPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fingerprint-')));
  memory = path.join(root, 'memory');
  notes = path.join(root, 'notes');
  fs.mkdirSync(memory);
  fs.mkdirSync(notes);
  dbPath = path.join(root, 'index.db');
  ctl.fail = false;
  fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
  fs.writeFileSync(path.join(notes, 'n.md'), '# N\n\nA note.\n');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function start(model = 'gemini-embedding-001', notesSource = 'notes'): Promise<MemoryIndexManager> {
  const m = new MemoryIndexManager('ag-main', 'main', memory, dbPath, 'test-key', model, [
    { dir: notes, source: notesSource, pathPrefix: 'extra/notes' },
  ]);
  await m.init();
  await vi.waitFor(() => expect((m as unknown as { _syncing: boolean })._syncing).toBe(false), { timeout: 5000 });
  await (m as unknown as { syncLock: Promise<void> }).syncLock;
  return m;
}

function rows(sql: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

const chunkStamps = () => rows('SELECT id, model, updated_at FROM chunks ORDER BY id');
const fingerprint = () => rows("SELECT value FROM meta WHERE key = 'index_fingerprint_v2'")[0]?.value;

// Each start waits on the shared embedding rate limiter (~1.2 s per batch).
describe('memory index start-up sync', { timeout: 20_000 }, () => {
  it('a restart with unchanged settings leaves unchanged files untouched', async () => {
    await (await start()).close();
    expect(fingerprint()).toBeDefined();
    const before = chunkStamps();
    expect(before.length).toBe(2);

    await new Promise((r) => setTimeout(r, 5));
    await (await start()).close();
    expect(chunkStamps()).toEqual(before);
  });

  it('a restart under another embedding model re-indexes every file', async () => {
    await (await start()).close();

    await (await start('gemini-embedding-002')).close();
    const after = chunkStamps();
    expect(after.length).toBe(2);
    expect(after.every((c) => c.model === 'gemini-embedding-002')).toBe(true);
    expect(fingerprint()).toContain('gemini-embedding-002');
  });

  it('a forced pass that leaves a file incomplete is forced again on the next start', async () => {
    await (await start()).close();
    const original = fingerprint();

    ctl.fail = true;
    await (await start('gemini-embedding-002')).close();
    expect(fingerprint()).toBe(original);

    ctl.fail = false;
    await (await start('gemini-embedding-002')).close();
    expect(chunkStamps().every((c) => c.model === 'gemini-embedding-002')).toBe(true);
    expect(fingerprint()).toContain('gemini-embedding-002');
  });

  it('a folder relabelled under the same paths takes its new source', async () => {
    await (await start()).close();

    await (await start('gemini-embedding-001', 'zettel')).close();
    expect(rows("SELECT source FROM files WHERE path = 'extra/notes/n.md'")).toEqual([{ source: 'zettel' }]);
    expect(rows("SELECT source FROM chunks WHERE path = 'extra/notes/n.md'")).toEqual([{ source: 'zettel' }]);
  });
});
