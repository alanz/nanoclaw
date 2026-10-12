/**
 * Vector rows can no longer drift silently. Live, 2026-10-13: 12,334 of
 * 26,238 chunks_vec rows had no chunk, because vector writes and deletes ran
 * inside empty catch blocks and a failed sqlite-vec load was never logged.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ vecLoadError: null as string | null, warn: vi.fn() }));

vi.mock('../log.js', () => ({
  log: { warn: ctl.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('./sqlite-vec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sqlite-vec.js')>();
  return {
    loadSqliteVecExtension: async (params: Parameters<typeof real.loadSqliteVecExtension>[0]) =>
      ctl.vecLoadError ? { ok: false, error: ctl.vecLoadError } : real.loadSqliteVecExtension(params),
  };
});

import { deleteFileChunks, getVectorState, insertChunk, openIndexDb, type IndexDb } from './index-db.js';

const DIMS = 3072;
let root: string;
let index: IndexDb;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-vec-'));
  ctl.vecLoadError = null;
  ctl.warn.mockClear();
});
afterEach(() => {
  index?.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function vector(first: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[0] = first;
  return v;
}

function insert(id: string, embedding: number[]): void {
  insertChunk(index.db, {
    id,
    path: 'groups/g/memory/a.md',
    source: 'memory',
    startLine: 1,
    endLine: 2,
    hash: 'h',
    model: 'gemini-embedding-001',
    text: 'alpha',
    embedding,
    vecAvailable: index.vecAvailable,
  });
}

function storedFirstComponent(id: string): number | undefined {
  const row = index.db.prepare('SELECT embedding FROM chunks_vec WHERE id = ?').get(id) as
    | { embedding: Buffer }
    | undefined;
  return row ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIMS)[0] : undefined;
}

describe('vector rows', () => {
  it('re-inserting a chunk id replaces its vector', async () => {
    index = await openIndexDb(path.join(root, 'index.db'), 'gemini-embedding-001');
    insert('c1', vector(1));
    insert('c1', vector(2));

    expect(storedFirstComponent('c1')).toBe(2);
    expect(getVectorState(index.db)).not.toBe('needs_repair');
    expect(ctl.warn).not.toHaveBeenCalled();
  });

  it('a vector delete that fails is logged and marks the index for repair', async () => {
    index = await openIndexDb(path.join(root, 'index.db'), 'gemini-embedding-001');
    insert('c1', vector(1));
    index.db.exec('DROP TABLE chunks_vec');

    deleteFileChunks(index.db, 'groups/g/memory/a.md', index.vecAvailable);

    expect(getVectorState(index.db)).toBe('needs_repair');
    expect(ctl.warn).toHaveBeenCalledWith(
      expect.stringContaining('vector row write failed'),
      expect.objectContaining({ op: 'delete', chunkId: 'c1' }),
    );
  });

  it('without sqlite-vec: the load error is logged, and writes and deletes mark the index for repair', async () => {
    ctl.vecLoadError = 'dlopen failed';
    index = await openIndexDb(path.join(root, 'index.db'), 'gemini-embedding-001');

    expect(index.vecAvailable).toBe(false);
    expect(index.vecError).toBe('dlopen failed');
    expect(ctl.warn).toHaveBeenCalledWith(
      expect.stringContaining('vector search unavailable'),
      expect.objectContaining({ error: 'dlopen failed' }),
    );
    expect(getVectorState(index.db)).toBeNull();

    insert('c1', vector(1));
    expect(getVectorState(index.db)).toBe('needs_repair');
  });

  it('a delete without sqlite-vec marks the index for repair', async () => {
    index = await openIndexDb(path.join(root, 'index.db'), 'gemini-embedding-001');
    insert('c1', vector(1));
    expect(getVectorState(index.db)).toBeNull();

    deleteFileChunks(index.db, 'groups/g/memory/a.md', false);
    expect(getVectorState(index.db)).toBe('needs_repair');
  });

  it('a vector size change recreates the vector table and marks the index for repair', async () => {
    const dbPath = path.join(root, 'index.db');
    index = await openIndexDb(dbPath, 'gemini-embedding-001', 8);
    index.db.close();

    index = await openIndexDb(dbPath, 'gemini-embedding-001', DIMS);
    const sql = (index.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_vec'").get() as { sql: string })
      .sql;
    expect(sql).toContain(`float[${DIMS}]`);
    expect(getVectorState(index.db)).toBe('needs_repair');
    expect(ctl.warn).toHaveBeenCalledWith(
      expect.stringContaining('vector size changed'),
      expect.objectContaining({ from: 8, to: DIMS }),
    );
  });

  it('drops the meta rows v1 left, and nothing else', async () => {
    const dbPath = path.join(root, 'index.db');
    index = await openIndexDb(dbPath, 'gemini-embedding-001');
    const put = index.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    put.run('memory_index_meta_v1', '{}');
    put.run('memory_index_config_v1', '{"extraPaths":["/Users/x/Sync/org"]}');
    put.run('index_fingerprint_v2', 'kept');
    index.db.close();

    index = await openIndexDb(dbPath, 'gemini-embedding-001');
    const keys = (index.db.prepare('SELECT key FROM meta ORDER BY key').all() as Array<{ key: string }>).map(
      (r) => r.key,
    );
    expect(keys).not.toContain('memory_index_meta_v1');
    expect(keys).not.toContain('memory_index_config_v1');
    expect(keys).toContain('index_fingerprint_v2');
  });
});
