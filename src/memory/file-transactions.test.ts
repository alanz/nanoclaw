/**
 * A file's index entries change in one transaction: a failure part-way through
 * writing a file leaves its previous entries whole, and the file is retried.
 * Before, its old chunks were already deleted, some new ones written, the files
 * row left stale, and the exception ended the whole sync silently.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ failOnText: null as string | null }));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));
vi.mock('./index-db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./index-db.js')>();
  return {
    ...real,
    insertChunk: (...args: Parameters<typeof real.insertChunk>) => {
      if (ctl.failOnText && args[1].text.includes(ctl.failOnText)) throw new Error('disk I/O error');
      return real.insertChunk(...args);
    },
  };
});

import { MemoryIndexManager } from './manager.js';

let root: string;
let memory: string;
let dbPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-txn-')));
  memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  dbPath = path.join(root, 'index.db');
  ctl.failOnText = null;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function settled(m: MemoryIndexManager): Promise<void> {
  await vi.waitFor(() => expect((m as unknown as { _syncing: boolean })._syncing).toBe(false), { timeout: 5000 });
  await (m as unknown as { syncLock: Promise<void> }).syncLock;
}

function snapshot(): { files: unknown[]; chunks: unknown[]; fts: unknown[]; vec: unknown[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      files: db.prepare('SELECT path, hash FROM files ORDER BY path').all(),
      chunks: db.prepare('SELECT id, text FROM chunks ORDER BY id').all(),
      fts: db.prepare('SELECT id FROM chunks_fts ORDER BY id').all(),
      vec: db.prepare('SELECT id FROM chunks_vec_rowids ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

// Two chunks: the second section is long enough to be split off the first.
const section = (word: string) => `## ${word}\n\n${`${word} `.repeat(500)}\n`;

describe('memory index file transactions', { timeout: 20_000 }, () => {
  it('a write that fails part-way keeps the file’s previous entries whole, and the next sync retries it', async () => {
    const file = path.join(memory, 'a.md');
    fs.writeFileSync(file, section('alpha') + section('beta'));
    const m = new MemoryIndexManager('ag-main', 'main', memory, dbPath, 'test-key', 'gemini-embedding-001');
    await m.init();
    await settled(m);
    const before = snapshot();
    expect(before.chunks.length).toBeGreaterThan(1);

    fs.writeFileSync(file, section('gamma') + section('delta'));
    ctl.failOnText = 'delta';
    await m.sync({ force: true });
    await settled(m);

    expect(snapshot()).toEqual(before);
    expect(m.isDirty).toBe(true);

    ctl.failOnText = null;
    await m.sync();
    const after = snapshot();
    expect(after.chunks.map((c) => (c as { text: string }).text).join(' ')).toContain('delta');
    expect(after.fts.length).toBe(after.chunks.length);
    expect(after.vec.length).toBe(after.chunks.length);
    await m.close();
  });
});
