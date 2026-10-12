/**
 * Stopping a memory sync part-way must leave the index as it was, and close()
 * must not wait on a native watcher that has not finished crawling.
 * Live, 2026-10-12: a host restart in the first minutes after start hung in
 * close() (watcher unsubscribe) until launchd killed it; the replacement host
 * then could not adopt the running session's container.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  fail: false,
  embedCalls: 0,
  unsubscribe: async () => {},
}));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => {
      ctl.embedCalls++;
      if (ctl.gate) await ctl.gate;
      if (ctl.fail) throw new Error('embedding service down');
      return texts.map(() => new Array(3072).fill(0.01));
    },
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: () => ctl.unsubscribe() }) },
}));

import { MemoryIndexManager } from './manager.js';

let root: string;
let memory: string;
let dbPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-close-')));
  memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  dbPath = path.join(root, 'index.db');
  Object.assign(ctl, { gate: null, fail: false, embedCalls: 0, unsubscribe: async () => {} });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function manager(): MemoryIndexManager {
  return new MemoryIndexManager('ag-main', 'main', memory, dbPath, 'test-key', 'gemini-embedding-001');
}

function indexedFiles(): Record<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT path, hash FROM files').all() as Array<{ path: string; hash: string }>;
    return Object.fromEntries(rows.map((r) => [path.basename(r.path), r.hash]));
  } finally {
    db.close();
  }
}

async function settledSync(m: MemoryIndexManager): Promise<void> {
  await vi.waitFor(() => expect((m as unknown as { _syncing: boolean })._syncing).toBe(false), { timeout: 5000 });
  await (m as unknown as { syncLock: Promise<void> }).syncLock;
}

describe('memory index manager', () => {
  it('close() returns even while a watcher never finishes unsubscribing', async () => {
    fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
    const m = manager();
    await m.init();
    await settledSync(m);
    ctl.unsubscribe = () => new Promise(() => {});

    const started = Date.now();
    await m.close();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a sync stopped part-way keeps the entries of files it did not reach', async () => {
    fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
    fs.writeFileSync(path.join(memory, 'b.md'), '# B\n\nBeta.\n');
    const m = manager();
    await m.init();
    await settledSync(m);
    const before = indexedFiles();
    expect(Object.keys(before).sort()).toEqual(['a.md', 'b.md']);

    fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha, revised.\n');
    fs.writeFileSync(path.join(memory, 'b.md'), '# B\n\nBeta, revised.\n');
    // A slow unsubscribe holds the index open after `closed` is set — the
    // window in which the sync runs on and reaches the stale pass.
    ctl.unsubscribe = () => new Promise((r) => setTimeout(r, 300));
    let release!: () => void;
    ctl.gate = new Promise((r) => (release = r));
    const calls = ctl.embedCalls;
    void m.sync({ force: true });
    await vi.waitFor(() => expect(ctl.embedCalls).toBe(calls + 1), { timeout: 5000 });

    const closing = m.close();
    release();
    await closing;

    // a.md's embedding was already in flight and completed, so it may be
    // written whole; b.md was never reached and keeps its entry — the stale
    // pass must not read "not visited" as "deleted".
    const after = indexedFiles();
    expect(Object.keys(after).sort()).toEqual(['a.md', 'b.md']);
    expect(after['b.md']).toBe(before['b.md']);
  });

  it('a file whose embedding fails is left unrecorded, so the next sync retries it', async () => {
    fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
    ctl.fail = true;
    const m = manager();
    await m.init();
    await settledSync(m);
    expect(indexedFiles()).toEqual({});

    ctl.fail = false;
    await m.sync();
    expect(Object.keys(indexedFiles())).toEqual(['a.md']);
    await m.close();
  });
});
