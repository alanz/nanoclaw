/**
 * Per-group search index database.
 *
 * Each agent group gets its own SQLite file at data/v2-memory/<group_id>/index.db.
 * This DB holds: files, chunks, FTS5 table, sqlite-vec virtual table (if available),
 * and an embedding_cache keyed by chunk hash.
 *
 * Containers mount this directory read-only at /workspace/memory/ and query
 * it directly with bun:sqlite for search, list, and get operations.
 */
import Database from 'better-sqlite3';

import { log } from '../log.js';
import { loadSqliteVecExtension } from './sqlite-vec.js';
import { buildFtsQuery, bm25RankToScore, groupByFile, mergeHybridResults, type FileSearchResult } from './hybrid.js';

export const VECTOR_TABLE = 'chunks_vec';
export const FTS_TABLE = 'chunks_fts';
export const CACHE_TABLE = 'embedding_cache';

const SNIPPET_MAX_CHARS = 700;
/** Snippets of a result's locations after its best one. */
const OTHER_SNIPPET_MAX_CHARS = 200;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function vectorToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0,
      bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export type IndexDb = {
  db: Database.Database;
  vecAvailable: boolean;
  /** Why sqlite-vec is unavailable, when it is. */
  vecError: string | null;
  model: string;
};

export async function openIndexDb(dbPath: string, model: string, dims = 3072): Promise<IndexDb> {
  const db = new Database(dbPath);
  // DELETE mode, not WAL: the index is mounted read-only into containers, and
  // WAL-mode databases require the reader to access the .db-wal + .db-shm files
  // on a read-write filesystem. On a read-only mount the container cannot update
  // the wal-index, so it only sees checkpointed data. DELETE mode writes atomically
  // to the main file and is visible to read-only mounts immediately after each commit.
  db.pragma('journal_mode = DELETE');

  const vecResult = await loadSqliteVecExtension({ db });
  let vecError = vecResult.ok ? null : (vecResult.error ?? 'unknown error');

  const vecTableError = ensureSchema(db, vecError === null, dims);
  if (vecError === null && vecTableError) vecError = `vector table: ${vecTableError}`;
  if (vecError !== null) {
    // Search falls back to an in-process scan, and vector rows are neither
    // written nor deleted: the index is marked for repair once vectors return.
    log.warn('Memory index: vector search unavailable', { dbPath, error: vecError });
  }

  dropV1MetaRows(db, dbPath);

  return { db, vecAvailable: vecError === null, vecError, model };
}

/**
 * v2's index started as a hand copy of v1's (2026-05-06). v1's meta rows came
 * with it; v2 never reads them, and one holds v1's host paths.
 */
function dropV1MetaRows(db: Database.Database, dbPath: string): void {
  const dropped = db
    .prepare("DELETE FROM meta WHERE key IN ('memory_index_meta_v1', 'memory_index_config_v1')")
    .run().changes;
  if (dropped > 0) log.info('Memory index: dropped v1 meta rows', { dbPath, dropped });
}

/** Returns why the vector table could not be created, if it could not. */
function ensureSchema(db: Database.Database, vecAvailable: boolean, dims: number): string | null {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (
      path    TEXT PRIMARY KEY,
      source  TEXT NOT NULL DEFAULT 'memory',
      hash    TEXT NOT NULL,
      mtime   INTEGER NOT NULL,
      size    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id         TEXT PRIMARY KEY,
      path       TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line   INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      model      TEXT NOT NULL,
      text       TEXT NOT NULL,
      embedding  TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
    CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
      provider     TEXT NOT NULL,
      model        TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash         TEXT NOT NULL,
      embedding    TEXT NOT NULL,
      dims         INTEGER,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${CACHE_TABLE}(updated_at);
  `);
  // A Zettelkasten note whose frontmatter names a superseded_by (spec:
  // MemoryFile.superseded). Search leaves these out unless asked; an index
  // from before the column learns each file's flag on its next sync.
  const fileCols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
  if (!fileCols.some((c) => c.name === 'superseded')) {
    db.exec('ALTER TABLE files ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(` +
      `  text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED` +
      `);`,
  );

  if (vecAvailable) {
    try {
      // A vector table of another size cannot take this model's vectors: drop
      // it. The full re-index a dims change forces refills it.
      const existing = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(VECTOR_TABLE) as
        | { sql: string }
        | undefined;
      const size = existing?.sql.match(/float\[(\d+)\]/)?.[1];
      if (size !== undefined && Number(size) !== dims) {
        log.warn('Memory index: vector size changed; recreating the vector table', { from: Number(size), to: dims });
        db.exec(`DROP TABLE ${VECTOR_TABLE}`);
        setVectorState(db, 'needs_repair');
      }
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(` +
          `  id TEXT PRIMARY KEY, embedding float[${dims}]` +
          `);`,
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return null;
}

const VECTOR_STATE_KEY = 'vector_state';

/**
 * Whether the vector rows are known to match the chunks: 'clean' after a
 * repair pass, 'needs_repair' once a vector write or delete failed or could
 * not be attempted, null for an index that has never been checked.
 */
export type VectorState = 'clean' | 'needs_repair' | null;

export function getVectorState(db: Database.Database): VectorState {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(VECTOR_STATE_KEY) as { value: string } | undefined;
  return row?.value === 'clean' || row?.value === 'needs_repair' ? row.value : null;
}

export function setVectorState(db: Database.Database, state: 'clean' | 'needs_repair'): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(VECTOR_STATE_KEY, state);
}

// One warning a minute per index: a vector table that fails, fails for every row.
const VECTOR_WARN_INTERVAL_MS = 60_000;
const vectorWarnings = new WeakMap<Database.Database, { at: number; suppressed: number }>();

/**
 * A vector row could not be written or deleted. Nothing is swallowed: the
 * index is marked for repair (the chunk row itself stands, searchable by
 * keyword and by the in-process scan) and the failure is logged.
 */
function vectorFailed(db: Database.Database, op: 'insert' | 'delete', id: string, err: unknown): void {
  setVectorState(db, 'needs_repair');
  const now = Date.now();
  const last = vectorWarnings.get(db);
  if (last && now - last.at < VECTOR_WARN_INTERVAL_MS) {
    last.suppressed++;
    return;
  }
  vectorWarnings.set(db, { at: now, suppressed: 0 });
  log.warn('Memory index: vector row write failed; index marked for repair', {
    op,
    chunkId: id,
    error: err instanceof Error ? err.message : String(err),
    suppressedSinceLastWarning: last?.suppressed ?? 0,
  });
}

export function getCachedEmbedding(
  db: Database.Database,
  model: string,
  providerKey: string,
  chunkHash: string,
): number[] | null {
  const row = db
    .prepare(`SELECT embedding FROM ${CACHE_TABLE} WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`)
    .get('gemini', model, providerKey, chunkHash) as { embedding: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.embedding) as number[];
  } catch {
    return null;
  }
}

export function saveCachedEmbedding(
  db: Database.Database,
  model: string,
  providerKey: string,
  chunkHash: string,
  embedding: number[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('gemini', model, providerKey, chunkHash, JSON.stringify(embedding), embedding.length, Date.now());
}

/**
 * Cache rows written before the provider key was recorded (key '') were all
 * made by `provider` against its one endpoint: give them their key, per model,
 * so they keep serving lookups. A row whose keyed twin already exists is
 * dropped.
 */
export function adoptUnkeyedCacheRows(
  db: Database.Database,
  provider: string,
  keyFor: (model: string) => string,
): number {
  const models = db
    .prepare(`SELECT DISTINCT model FROM ${CACHE_TABLE} WHERE provider = ? AND provider_key = ''`)
    .all(provider) as Array<{ model: string }>;
  if (models.length === 0) return 0;
  let adopted = 0;
  db.transaction(() => {
    for (const { model } of models) {
      adopted += db
        .prepare(
          `UPDATE OR IGNORE ${CACHE_TABLE} SET provider_key = ? WHERE provider = ? AND model = ? AND provider_key = ''`,
        )
        .run(keyFor(model), provider, model).changes;
    }
    db.prepare(`DELETE FROM ${CACHE_TABLE} WHERE provider = ? AND provider_key = ''`).run(provider);
  })();
  log.info('Memory index: cache rows given their provider key', { adopted });
  return adopted;
}

export function deleteFileChunks(db: Database.Database, filePath: string, vecAvailable: boolean): void {
  const chunkIds = (db.prepare('SELECT id FROM chunks WHERE path = ?').all(filePath) as Array<{ id: string }>).map(
    (r) => r.id,
  );

  db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ?`).run(filePath);

  if (chunkIds.length === 0) return;
  // Without sqlite-vec the vector rows cannot be reached; left behind, they
  // are orphans until the repair pass removes them.
  if (!vecAvailable) {
    setVectorState(db, 'needs_repair');
    return;
  }
  for (const id of chunkIds) {
    try {
      db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
    } catch (err) {
      vectorFailed(db, 'delete', id, err);
    }
  }
}

export function insertChunk(
  db: Database.Database,
  params: {
    id: string;
    path: string;
    source: string;
    startLine: number;
    endLine: number;
    hash: string;
    model: string;
    text: string;
    embedding: number[];
    vecAvailable: boolean;
  },
): void {
  const now = Date.now();
  const embeddingJson = JSON.stringify(params.embedding);

  db.prepare(
    `INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.path,
    params.source,
    params.startLine,
    params.endLine,
    params.hash,
    params.model,
    params.text,
    embeddingJson,
    now,
  );

  if (params.vecAvailable) {
    // vec0 does not honour INSERT OR REPLACE: on an existing id it throws, and
    // the old vector stays. Delete, then insert.
    try {
      db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(params.id);
      db.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`).run(
        params.id,
        vectorToBuffer(params.embedding),
      );
    } catch (err) {
      vectorFailed(db, 'insert', params.id, err);
    }
  } else {
    // The chunk has no vector until the repair pass writes it.
    setVectorState(db, 'needs_repair');
  }

  db.prepare(
    `INSERT OR REPLACE INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(params.text, params.id, params.path, params.source, params.model, params.startLine, params.endLine);
}

export type VectorRepair = { removed: number; added: number; failed: number };

/**
 * Bring the vector rows back in line with the chunks, from data already in
 * the index (no embedding calls): delete vector rows whose chunk is gone, and
 * write the missing vector of any chunk from its stored embedding. Marks the
 * index clean only when every row was put right. Needs sqlite-vec.
 */
export function repairVectors(index: IndexDb): VectorRepair | null {
  const { db } = index;
  if (!index.vecAvailable) return null;
  const result: VectorRepair = { removed: 0, added: 0, failed: 0 };
  db.transaction(() => {
    // vec0 keeps its ids in the chunks_vec_rowids shadow table; reading it
    // there avoids a scan of the vectors themselves.
    const orphans = db
      .prepare(`SELECT r.id FROM ${VECTOR_TABLE}_rowids r WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = r.id)`)
      .all() as Array<{ id: string }>;
    const remove = db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`);
    for (const { id } of orphans) {
      try {
        remove.run(id);
        result.removed++;
      } catch (err) {
        result.failed++;
        vectorFailed(db, 'delete', id, err);
      }
    }

    const missing = db
      .prepare(
        // Only this model's embeddings fit the table; a chunk of another model
        // gets its vector when it is re-indexed.
        `SELECT c.id, c.embedding FROM chunks c WHERE c.model = ? AND NOT EXISTS (SELECT 1 FROM ${VECTOR_TABLE}_rowids r WHERE r.id = c.id)`,
      )
      .all(index.model) as Array<{ id: string; embedding: string }>;
    const insert = db.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`);
    for (const { id, embedding } of missing) {
      try {
        insert.run(id, vectorToBuffer(JSON.parse(embedding) as number[]));
        result.added++;
      } catch (err) {
        result.failed++;
        vectorFailed(db, 'insert', id, err);
      }
    }

    if (result.failed === 0) setVectorState(db, 'clean');
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      LAST_REPAIR_KEY,
      JSON.stringify({ at: new Date().toISOString(), ...result }),
    );
  })();
  return result;
}

const LAST_CACHE_PRUNE_KEY = 'last_cache_prune';

/**
 * Drop cache rows no chunk uses (by hash and model) that were written before
 * `writtenBefore` (ms epoch). The age is a grace window: an edit undone soon
 * after still finds its old text's embedding. A hit does not refresh a row's
 * age, so the window runs from when the embedding was made.
 */
export function pruneEmbeddingCache(db: Database.Database, writtenBefore: number): number {
  const removed = db
    .prepare(
      `DELETE FROM ${CACHE_TABLE} WHERE updated_at < ? AND NOT EXISTS ` +
        `(SELECT 1 FROM chunks c WHERE c.hash = ${CACHE_TABLE}.hash AND c.model = ${CACHE_TABLE}.model)`,
    )
    .run(writtenBefore).changes;
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    LAST_CACHE_PRUNE_KEY,
    JSON.stringify({ at: new Date().toISOString(), removed }),
  );
  return removed;
}

export function getLastCachePrune(db: Database.Database): { at: string; removed: number } | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LAST_CACHE_PRUNE_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as { at: string; removed: number };
  } catch {
    return null;
  }
}

const LAST_REPAIR_KEY = 'last_vector_repair';
const LAST_FULL_REINDEX_KEY = 'last_full_reindex';

/** The last full re-index: why, when, how many files, and how it ended. */
export type FullReindexRecord = {
  reason: string;
  startedAt: string;
  finishedAt: string | null;
  files: number;
  result: 'running' | 'completed' | 'incomplete' | 'interrupted';
};

export function setLastFullReindex(db: Database.Database, record: FullReindexRecord): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    LAST_FULL_REINDEX_KEY,
    JSON.stringify(record),
  );
}

/** A record still 'running' when read at start belongs to a host that died mid-pass. */
export function getLastFullReindex(db: Database.Database): FullReindexRecord | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LAST_FULL_REINDEX_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as FullReindexRecord;
  } catch {
    return null;
  }
}

export function getLastVectorRepair(db: Database.Database): (VectorRepair & { at: string }) | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(LAST_REPAIR_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as VectorRepair & { at: string };
  } catch {
    return null;
  }
}

export function upsertFileRecord(
  db: Database.Database,
  params: { path: string; source: string; hash: string; mtimeMs: number; size: number; superseded?: boolean },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO files (path, source, hash, mtime, size, superseded) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(params.path, params.source, params.hash, Math.round(params.mtimeMs), params.size, params.superseded ? 1 : 0);
}

/**
 * Whether a note's frontmatter names the note that superseded it
 * (memory-graph.allium superseded_by): a non-empty `superseded_by:` value,
 * scalar or list. Only a leading YAML block counts.
 */
export function namesSupersededBy(content: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return false;
  const line = /^superseded_by:[ \t]*(.*)$/m.exec(match[1]);
  if (!line) return false;
  const value = line[1].trim().replace(/^['"]|['"]$/g, '');
  return value !== '' && value !== '[]' && value !== 'null' && value !== '~';
}

const FINGERPRINT_KEY = 'index_fingerprint_v2';

/** The settings the index was last fully built with (see MemoryIndexManager.init). */
export function getIndexFingerprint(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setIndexFingerprint(db: Database.Database, fingerprint: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FINGERPRINT_KEY, fingerprint);
}

export type { FileSearchResult };

export function searchIndex(
  index: IndexDb,
  query: string,
  queryVec: number[],
  opts: {
    limit: number;
    minScore: number;
    pathPrefix?: string;
    source?: string;
    /** Include superseded notes (default: leave them out). */
    includeSuperseded?: boolean;
    vectorWeight: number;
    textWeight: number;
    candidatesMultiplier: number;
    locationsPerFile: number;
  },
): FileSearchResult[] {
  const { db, vecAvailable, model } = index;
  const candidates = opts.limit * opts.candidatesMultiplier;
  // Filters narrow the candidates in SQL, before LIMIT: a match inside them is
  // never displaced by better-ranked matches outside them.
  const filter = (col: (name: string) => string) => {
    const clauses: string[] = [];
    const args: string[] = [];
    if (opts.source) {
      clauses.push(` AND ${col('source')} = ?`);
      args.push(opts.source);
    }
    if (opts.pathPrefix) {
      clauses.push(` AND substr(${col('path')}, 1, length(?)) = ?`);
      args.push(opts.pathPrefix, opts.pathPrefix);
    }
    if (!opts.includeSuperseded) {
      clauses.push(` AND ${col('path')} NOT IN (SELECT path FROM files WHERE superseded = 1)`);
    }
    return { sql: clauses.join(''), args };
  };

  // --- vector search ---
  const vectorResults: ReturnType<typeof mergeHybridResults>[0][] = [];
  if (queryVec.length > 0) {
    if (vecAvailable) {
      const where = filter((name) => `c.${name}`);
      const bindArgs: unknown[] = [vectorToBuffer(queryVec), model, ...where.args, candidates];
      const rows = db
        .prepare(
          `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,` +
            `       vec_distance_cosine(v.embedding, ?) AS dist` +
            `  FROM ${VECTOR_TABLE} v` +
            `  JOIN chunks c ON c.id = v.id` +
            ` WHERE c.model = ?${where.sql}` +
            ` ORDER BY dist ASC` +
            ` LIMIT ?`,
        )
        .all(...bindArgs) as Array<{
        id: string;
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        source: string;
        dist: number;
      }>;
      for (const r of rows) {
        vectorResults.push({
          id: r.id,
          path: r.path,
          startLine: r.start_line,
          endLine: r.end_line,
          score: 1 - r.dist,
          snippet: truncate(r.text, SNIPPET_MAX_CHARS),
          source: r.source,
        });
      }
    } else {
      // In-memory cosine similarity fallback
      const where = filter((name) => name);
      const rows = db
        .prepare(
          `SELECT id, path, start_line, end_line, text, embedding, source FROM chunks WHERE model = ?${where.sql}`,
        )
        .all(model, ...where.args) as Array<{
        id: string;
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        embedding: string;
        source: string;
      }>;
      for (const r of rows) {
        let vec: number[] = [];
        try {
          vec = JSON.parse(r.embedding) as number[];
        } catch {}
        const score = cosineSimilarity(queryVec, vec);
        if (Number.isFinite(score)) {
          vectorResults.push({
            id: r.id,
            path: r.path,
            startLine: r.start_line,
            endLine: r.end_line,
            score,
            snippet: truncate(r.text, SNIPPET_MAX_CHARS),
            source: r.source,
          });
        }
      }
      vectorResults.sort((a, b) => b.score - a.score);
      vectorResults.splice(candidates);
    }
  }

  // --- FTS5 keyword search ---
  const keywordResults: (ReturnType<typeof mergeHybridResults>[0] & { textScore: number })[] = [];
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    const where = filter((name) => name);
    const rows = db
      .prepare(
        `SELECT id, path, source, start_line, end_line, text, bm25(${FTS_TABLE}) AS rank` +
          `  FROM ${FTS_TABLE}` +
          ` WHERE ${FTS_TABLE} MATCH ? AND model = ?${where.sql}` +
          ` ORDER BY rank ASC LIMIT ?`,
      )
      .all(ftsQuery, model, ...where.args, candidates) as Array<{
      id: string;
      path: string;
      source: string;
      start_line: number;
      end_line: number;
      text: string;
      rank: number;
    }>;
    for (const r of rows) {
      const textScore = bm25RankToScore(r.rank);
      keywordResults.push({
        id: r.id,
        path: r.path,
        startLine: r.start_line,
        endLine: r.end_line,
        score: textScore,
        snippet: truncate(r.text, SNIPPET_MAX_CHARS),
        source: r.source,
        textScore,
      });
    }
  }

  const merged = mergeHybridResults({
    vector: vectorResults.map((r) => ({ ...r, vectorScore: r.score })),
    keyword: keywordResults.map((r) => ({ ...r, textScore: r.textScore })),
    vectorWeight: opts.vectorWeight,
    textWeight: opts.textWeight,
  });

  return groupByFile(
    merged.filter((r) => r.score >= opts.minScore),
    { limit: opts.limit, locationsPerFile: opts.locationsPerFile, otherSnippetChars: OTHER_SNIPPET_MAX_CHARS },
  );
}
