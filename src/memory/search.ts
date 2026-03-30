import type Database from 'better-sqlite3';
import { cosineSimilarity, parseEmbedding } from './internal.js';
import { buildFtsQuery, bm25RankToScore } from './hybrid.js';

const SNIPPET_MAX_CHARS = 700;

/** Truncate text safely for display without breaking UTF-16 surrogate pairs. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Walk backwards from maxChars to avoid cutting a surrogate pair
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // high surrogate
  return text.slice(0, end);
}

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

export function searchVector(params: {
  db: Database.Database;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  limit: number;
  vecAvailable: boolean;
  source?: string;
}): SearchRowResult[] {
  if (params.queryVec.length === 0 || params.limit <= 0) return [];

  if (params.vecAvailable) {
    const sourceClause = params.source ? ' AND c.source = ?' : '';
    const bindArgs: unknown[] = [
      vectorToBlob(params.queryVec),
      params.providerModel,
      ...(params.source ? [params.source] : []),
      params.limit,
    ];
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${sourceClause}\n` +
          ` ORDER BY dist ASC\n` +
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
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: truncate(row.text, SNIPPET_MAX_CHARS),
      source: row.source,
    }));
  }

  // Fallback: in-memory cosine similarity
  const fallbackSourceClause = params.source ? ' AND source = ?' : '';
  const fallbackBindArgs: unknown[] = [
    params.providerModel,
    ...(params.source ? [params.source] : []),
  ];
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source FROM chunks WHERE model = ?${fallbackSourceClause}`,
    )
    .all(...fallbackBindArgs) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: string;
  }>;

  return rows
    .map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: cosineSimilarity(params.queryVec, parseEmbedding(row.embedding)),
      snippet: truncate(row.text, SNIPPET_MAX_CHARS),
      source: row.source,
    }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit);
}

export function searchKeyword(params: {
  db: Database.Database;
  ftsTable: string;
  providerModel: string;
  query: string;
  limit: number;
  source?: string;
}): Array<SearchRowResult & { textScore: number }> {
  if (params.limit <= 0) return [];
  const ftsQuery = buildFtsQuery(params.query);
  if (!ftsQuery) return [];

  const sourceClause = params.source ? ' AND source = ?' : '';
  const bindArgs: unknown[] = [
    ftsQuery,
    params.providerModel,
    ...(params.source ? [params.source] : []),
    params.limit,
  ];
  const rows = params.db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,\n` +
        `       bm25(${params.ftsTable}) AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${params.ftsTable} MATCH ? AND model = ?${sourceClause}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(...bindArgs) as Array<{
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  return rows.map((row) => {
    const textScore = bm25RankToScore(row.rank);
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet: truncate(row.text, SNIPPET_MAX_CHARS),
      source: row.source,
    };
  });
}
