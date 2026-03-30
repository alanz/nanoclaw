import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { searchVector, searchKeyword } from './search.js';
import { ensureMemoryIndexSchema } from './schema.js';

const FTS_TABLE = 'chunks_fts';
const MODEL = 'test-model';

/** Build a tiny in-memory DB with chunks tagged by source. */
function makeDb(
  chunks: Array<{
    id: string;
    text: string;
    source: string;
    embedding: number[];
  }>,
): Database.Database {
  const db = new Database(':memory:');
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: 'embedding_cache',
    ftsTable: FTS_TABLE,
  });

  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, ?, 0, 1, 'h', ?, ?, ?, 0)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO ${FTS_TABLE} (id, path, source, model, start_line, end_line, text)
     VALUES (?, ?, ?, ?, 0, 1, ?)`,
  );

  for (const c of chunks) {
    const embJson = JSON.stringify(c.embedding);
    insertChunk.run(c.id, `path/${c.id}`, c.source, MODEL, c.text, embJson);
    insertFts.run(c.id, `path/${c.id}`, c.source, MODEL, c.text);
  }

  return db;
}

const chunks = [
  {
    id: 'z1',
    text: 'neural networks paper abstract',
    source: 'zotero-md',
    embedding: [0.9, 0.1, 0.0, 0.0],
  },
  {
    id: 'z2',
    text: 'transformer architecture review',
    source: 'zotero-md',
    embedding: [0.8, 0.2, 0.0, 0.0],
  },
  {
    id: 'o1',
    text: 'org mode task notes neural',
    source: 'org',
    embedding: [0.7, 0.3, 0.0, 0.0],
  },
  {
    id: 'o2',
    text: 'org daily log entry',
    source: 'org',
    embedding: [0.6, 0.4, 0.0, 0.0],
  },
  {
    id: 'o3',
    text: 'org weekly review neural networks',
    source: 'org',
    embedding: [0.85, 0.15, 0.0, 0.0],
  },
  {
    id: 'm1',
    text: 'memory notes on neural nets',
    source: 'memory',
    embedding: [0.75, 0.25, 0.0, 0.0],
  },
];

describe('searchVector with source filter (fallback cosine path)', () => {
  const db = makeDb(chunks);
  // vecAvailable=false forces the in-memory cosine fallback path
  const base = {
    db,
    vectorTable: 'unused',
    providerModel: MODEL,
    vecAvailable: false,
  };
  const queryVec = [1.0, 0.0, 0.0, 0.0]; // closest to high [0] dimension

  it('returns only zotero-md chunks when source="zotero-md"', () => {
    const results = searchVector({
      ...base,
      queryVec,
      limit: 10,
      source: 'zotero-md',
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.source === 'zotero-md')).toBe(true);
    expect(results.map((r) => r.id).sort()).toEqual(['z1', 'z2']);
  });

  it('returns only org chunks when source="org"', () => {
    const results = searchVector({
      ...base,
      queryVec,
      limit: 10,
      source: 'org',
    });
    expect(results.every((r) => r.source === 'org')).toBe(true);
    expect(results.map((r) => r.id).sort()).toEqual(['o1', 'o2', 'o3']);
  });

  it('returns all sources when source is omitted', () => {
    const results = searchVector({ ...base, queryVec, limit: 10 });
    const sources = new Set(results.map((r) => r.source));
    expect(sources).toEqual(new Set(['zotero-md', 'org', 'memory']));
  });

  it('respects limit within the filtered source pool', () => {
    const results = searchVector({
      ...base,
      queryVec,
      limit: 1,
      source: 'org',
    });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('org');
  });
});

describe('searchKeyword with source filter', () => {
  const db = makeDb(chunks);
  const base = { db, ftsTable: FTS_TABLE, providerModel: MODEL };

  it('returns only zotero-md chunks when source="zotero-md"', () => {
    const results = searchKeyword({
      ...base,
      query: 'neural',
      limit: 10,
      source: 'zotero-md',
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.source === 'zotero-md')).toBe(true);
  });

  it('returns only org chunks when source="org"', () => {
    const results = searchKeyword({
      ...base,
      query: 'neural',
      limit: 10,
      source: 'org',
    });
    expect(results.every((r) => r.source === 'org')).toBe(true);
  });

  it('returns all sources when source is omitted', () => {
    const results = searchKeyword({ ...base, query: 'neural', limit: 10 });
    const sources = new Set(results.map((r) => r.source));
    expect(sources.size).toBeGreaterThan(1);
  });

  it('respects limit within the filtered source pool', () => {
    const results = searchKeyword({
      ...base,
      query: 'neural',
      limit: 1,
      source: 'org',
    });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('org');
  });
});
