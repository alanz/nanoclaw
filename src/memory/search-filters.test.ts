/**
 * memory_hybrid_search filters narrow the candidates before ranking
 * (specs/memory.allium, MemorySearched): a match inside path_prefix / source
 * is never displaced by better-ranked matches outside it. Live, 2026-10-11:
 * "emacs" under zettel/notes had 27 matches, but the 24 best overall were
 * mostly org chunks, so a prefix search returned 1.
 *
 * The query embedding is bounded too: a search that gets no embedding permit
 * in time runs keyword-only instead of queueing behind indexing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ embedQuery: 0 }));

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
    embedQuery: async () => {
      calls.embedQuery++;
      return new Array(3072).fill(0.01);
    },
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { insertChunk, openIndexDb, searchIndex, type IndexDb } from './index-db.js';
import { MemoryIndexManager } from './manager.js';

const MODEL = 'm';
const NOTES = 'groups/g/zettel/notes/';
const vec = (x: number) => new Array(3072).fill(0).map((_, i) => (i === 0 ? 1 : x));

let root: string;
let index: IndexDb;

function add(id: string, p: string, source: string, text: string, embedding: number[]): void {
  insertChunk(index.db, {
    id,
    path: p,
    source,
    startLine: 1,
    endLine: 1,
    hash: id,
    model: MODEL,
    text,
    embedding,
    vecAvailable: index.vecAvailable,
  });
}

const opts = { limit: 6, minScore: 0, vectorWeight: 0.7, textWeight: 0.3, candidatesMultiplier: 4 };

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-filters-')));
  index = await openIndexDb(path.join(root, 'index.db'), MODEL);
  // 40 org chunks that outrank everything on both keyword and vector score.
  for (let i = 0; i < 40; i++) add(`org-${i}`, `extra/org/f${i}.org`, 'org', 'emacs emacs emacs emacs', vec(0));
  add('note-1', `${NOTES}a.md`, 'zettel', 'emacs and a lot of other words about other things', vec(0.5));
  add('note-2', `${NOTES}b.md`, 'zettel', 'emacs once among many unrelated words here', vec(0.5));
  add('report', 'groups/g/zettel/reports/r.md', 'zettel', 'emacs emacs emacs', vec(0.1));
});
afterEach(() => {
  index.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('searchIndex filters', () => {
  it('keyword-only: path_prefix matches are not crowded out by better-ranked ones elsewhere', () => {
    const results = searchIndex(index, 'emacs', [], { ...opts, pathPrefix: NOTES });
    expect(results.map((r) => r.path).sort()).toEqual([`${NOTES}a.md`, `${NOTES}b.md`]);
  });

  it('hybrid: path_prefix narrows the vector candidates too', () => {
    const results = searchIndex(index, 'emacs', vec(0), { ...opts, pathPrefix: NOTES });
    expect(results.map((r) => r.path).sort()).toEqual([`${NOTES}a.md`, `${NOTES}b.md`]);
  });

  it('source narrows the candidates, and combines with path_prefix', () => {
    expect(searchIndex(index, 'emacs', vec(0), { ...opts, source: 'zettel' })).toHaveLength(3);
    expect(searchIndex(index, 'emacs', vec(0), { ...opts, source: 'org', pathPrefix: NOTES })).toEqual([]);
  });

  it('path_prefix is a literal prefix: LIKE wildcards in it match nothing extra', () => {
    expect(searchIndex(index, 'emacs', [], { ...opts, pathPrefix: 'groups/g/zettel/n_tes/' })).toEqual([]);
    expect(searchIndex(index, 'emacs', [], { ...opts, pathPrefix: 'groups/g/zettel/%' })).toEqual([]);
  });
});

describe('MemoryIndexManager.search embedding permit', () => {
  async function manager(): Promise<MemoryIndexManager> {
    const memory = path.join(root, 'memory');
    fs.mkdirSync(memory);
    const m = new MemoryIndexManager('ag-g', 'g', memory, path.join(root, 'm.db'), 'key', MODEL);
    await m.init();
    return m;
  }
  type WithLimiter = { rateLimiter: { acquirePermit: (...args: unknown[]) => Promise<void> } };

  it('is hybrid when the permit is granted', async () => {
    calls.embedQuery = 0;
    const m = await manager();
    (m as unknown as WithLimiter).rateLimiter = { acquirePermit: async () => {} };
    expect((await m.search('anything', { embedWaitMs: 50 })).mode).toBe('hybrid');
    expect(calls.embedQuery).toBe(1);
    await m.close();
  });

  it('runs keyword-only, without waiting, when no permit comes within the wait', async () => {
    calls.embedQuery = 0;
    const m = await manager();
    (m as unknown as WithLimiter).rateLimiter = { acquirePermit: () => new Promise(() => {}) };
    const started = Date.now();
    expect((await m.search('anything', { embedWaitMs: 50 })).mode).toBe('keyword');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls.embedQuery).toBe(0);
    await m.close();
  });

  it('a permit refused after the wait does not surface as an unhandled rejection', async () => {
    const m = await manager();
    let refuse!: (err: Error) => void;
    (m as unknown as WithLimiter).rateLimiter = {
      acquirePermit: () => new Promise((_, reject) => (refuse = reject)),
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    expect((await m.search('anything', { embedWaitMs: 20 })).mode).toBe('keyword');
    refuse(new Error('daily stop'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    await m.close();
  });
});
