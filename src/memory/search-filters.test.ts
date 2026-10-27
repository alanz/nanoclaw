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

import { groupByFile } from './hybrid.js';
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

const opts = {
  limit: 6,
  minScore: 0,
  vectorWeight: 0.7,
  textWeight: 0.3,
  candidatesMultiplier: 8,
  locationsPerFile: 3,
};

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

  it('keyword-only with the default min_score still finds a matching file', async () => {
    // Weighted as in hybrid mode a keyword-only score topped out below 0.3,
    // under the 0.35 default, so every keyword-only search came back empty.
    const memory = path.join(root, 'memory');
    fs.mkdirSync(memory);
    fs.writeFileSync(path.join(memory, 'note.md'), '# Zebra\n\nA note about zebra crossings.\n');
    // Other files, so the keyword weighting has a corpus to rank against.
    for (let i = 0; i < 8; i++)
      fs.writeFileSync(path.join(memory, `other-${i}.md`), `# Other ${i}\n\nUnrelated words.\n`);
    const m = new MemoryIndexManager('ag-g', 'g', memory, path.join(root, 'm.db'), 'key', MODEL);
    (m as unknown as WithLimiter).rateLimiter = { acquirePermit: async () => {} };
    await m.init();
    await m.sync();
    (m as unknown as WithLimiter).rateLimiter = { acquirePermit: () => new Promise(() => {}) };
    const answer = await m.search('zebra', { embedWaitMs: 20 });
    expect(answer.mode).toBe('keyword');
    expect(answer.results.map((r) => path.basename(r.path))).toEqual(['note.md']);
    expect(answer.results[0].score).toBeGreaterThan(0.3);
    await m.close();
  }, 20_000);

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

// One result per file (specs/memory.allium, MemorySearchResult): chunks of a
// file group into locations; overlapping chunks merge; at most
// locationsPerFile listed, the rest counted.
describe('groupByFile', () => {
  const chunk = (p: string, startLine: number, endLine: number, score: number, snippet = 'x'.repeat(700)) => ({
    path: p,
    source: 'zettel',
    startLine,
    endLine,
    score,
    snippet,
  });
  const group = (chunks: ReturnType<typeof chunk>[], limit = 6) =>
    groupByFile(chunks, { limit, locationsPerFile: 3, otherSnippetChars: 200 });

  it('ranks files by their best chunk, and limit counts files', () => {
    const results = group(
      [chunk('a.md', 1, 10, 0.9), chunk('b.md', 1, 10, 0.8), chunk('a.md', 50, 60, 0.7), chunk('c.md', 1, 10, 0.6)],
      2,
    );
    expect(results.map((r) => [r.path, r.score])).toEqual([
      ['a.md', 0.9],
      ['b.md', 0.8],
    ]);
    expect(results[0]!.locations.map((l) => [l.startLine, l.endLine])).toEqual([
      [1, 10],
      [50, 60],
    ]);
  });

  it('merges overlapping chunks into one location with the better score and its snippet', () => {
    const [result] = group([
      chunk('a.md', 44, 59, 0.6, 'later'),
      chunk('a.md', 36, 47, 0.8, 'earlier'),
      chunk('a.md', 60, 70, 0.5),
    ]);
    expect(result!.locations).toEqual([
      { startLine: 36, endLine: 59, score: 0.8, snippet: 'earlier' },
      { startLine: 60, endLine: 70, score: 0.5, snippet: 'x'.repeat(200) },
    ]);
  });

  it('lists at most locationsPerFile, best first, counts the rest, and shortens all but the best snippet', () => {
    const scores = [0.5, 0.9, 0.7, 0.6, 0.8];
    const [result] = group(scores.map((s, i) => chunk('a.md', i * 100, i * 100 + 10, s)));
    expect(result!.locations.map((l) => l.score)).toEqual([0.9, 0.8, 0.7]);
    expect(result!.moreLocations).toBe(2);
    expect(result!.locations.map((l) => l.snippet.length)).toEqual([700, 200, 200]);
  });
});
