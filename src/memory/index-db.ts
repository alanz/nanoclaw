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

import { loadSqliteVecExtension } from './sqlite-vec.js';
import { buildFtsQuery, bm25RankToScore, mergeHybridResults } from './hybrid.js';

export const VECTOR_TABLE = 'chunks_vec';
export const FTS_TABLE = 'chunks_fts';
export const CACHE_TABLE = 'embedding_cache';

const SNIPPET_MAX_CHARS = 700;

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
  model: string;
};

export async function openIndexDb(dbPath: string, model: string): Promise<IndexDb> {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const vecResult = await loadSqliteVecExtension({ db });
  const vecAvailable = vecResult.ok;

  ensureSchema(db, vecAvailable, 3072);

  return { db, vecAvailable, model };
}

function ensureSchema(db: Database.Database, vecAvailable: boolean, dims: number): void {
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

  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(` +
      `  text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED` +
      `);`,
  );

  if (vecAvailable) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(` +
          `  id TEXT PRIMARY KEY, embedding float[${dims}]` +
          `);`,
      );
    } catch {}
  }
}

export function getCachedEmbedding(db: Database.Database, model: string, chunkHash: string): number[] | null {
  const row = db
    .prepare(`SELECT embedding FROM ${CACHE_TABLE} WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`)
    .get('gemini', model, '', chunkHash) as { embedding: string } | undefined;
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
  chunkHash: string,
  embedding: number[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('gemini', model, '', chunkHash, JSON.stringify(embedding), embedding.length, Date.now());
}

export function deleteFileChunks(db: Database.Database, filePath: string, vecAvailable: boolean): void {
  const chunkIds = (db.prepare('SELECT id FROM chunks WHERE path = ?').all(filePath) as Array<{ id: string }>).map(
    (r) => r.id,
  );

  db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ?`).run(filePath);

  if (vecAvailable && chunkIds.length > 0) {
    for (const id of chunkIds) {
      try {
        db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
      } catch {}
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
    try {
      db.prepare(`INSERT OR REPLACE INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`).run(
        params.id,
        vectorToBuffer(params.embedding),
      );
    } catch {}
  }

  db.prepare(
    `INSERT OR REPLACE INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(params.text, params.id, params.path, params.source, params.model, params.startLine, params.endLine);
}

export function upsertFileRecord(
  db: Database.Database,
  params: { path: string; source: string; hash: string; mtimeMs: number; size: number },
): void {
  db.prepare(`INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`).run(
    params.path,
    params.source,
    params.hash,
    Math.round(params.mtimeMs),
    params.size,
  );
}

export type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

export function searchIndex(
  index: IndexDb,
  query: string,
  queryVec: number[],
  opts: {
    limit: number;
    minScore: number;
    pathPrefix?: string;
    source?: string;
    vectorWeight: number;
    textWeight: number;
    candidatesMultiplier: number;
  },
): SearchResult[] {
  const { db, vecAvailable, model } = index;
  const candidates = opts.limit * opts.candidatesMultiplier;

  // --- vector search ---
  const vectorResults: ReturnType<typeof mergeHybridResults>[0][] = [];
  if (queryVec.length > 0) {
    if (vecAvailable) {
      const sourceClause = opts.source ? ' AND c.source = ?' : '';
      const bindArgs: unknown[] = [vectorToBuffer(queryVec), model, ...(opts.source ? [opts.source] : []), candidates];
      const rows = db
        .prepare(
          `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,` +
            `       vec_distance_cosine(v.embedding, ?) AS dist` +
            `  FROM ${VECTOR_TABLE} v` +
            `  JOIN chunks c ON c.id = v.id` +
            ` WHERE c.model = ?${sourceClause}` +
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
      const sourceClause = opts.source ? ' AND source = ?' : '';
      const rows = db
        .prepare(
          `SELECT id, path, start_line, end_line, text, embedding, source FROM chunks WHERE model = ?${sourceClause}`,
        )
        .all(model, ...(opts.source ? [opts.source] : [])) as Array<{
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
    const sourceClause = opts.source ? ' AND source = ?' : '';
    const rows = db
      .prepare(
        `SELECT id, path, source, start_line, end_line, text, bm25(${FTS_TABLE}) AS rank` +
          `  FROM ${FTS_TABLE}` +
          ` WHERE ${FTS_TABLE} MATCH ? AND model = ?${sourceClause}` +
          ` ORDER BY rank ASC LIMIT ?`,
      )
      .all(ftsQuery, model, ...(opts.source ? [opts.source] : []), candidates) as Array<{
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

  return merged
    .filter((r) => r.score >= opts.minScore)
    .filter((r) => !opts.pathPrefix || r.path.startsWith(opts.pathPrefix))
    .slice(0, opts.limit);
}
