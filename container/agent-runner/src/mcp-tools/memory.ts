/**
 * Memory MCP tools: memory_search, memory_get_file_content, memory_list_files.
 *
 * Only available in non-specialist containers. The host maintains a per-group
 * SQLite index at data/v2-memory/<group_id>/index.db, mounted read-only at
 * /workspace/memory/index.db.
 *
 * Search is the host's hybrid (vector + keyword) search: the host holds the
 * embedding key and budget. The tool writes a memory_search_request system
 * message and waits for the matching response in inbound.db. If none comes in
 * time, it runs FTS5 keyword search on the read-only index itself. Get and list
 * read the index directly — no host round-trip.
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { findCliResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const INDEX_PATH = '/workspace/memory/index.db';
const FTS_TABLE = 'chunks_fts';
const SNIPPET_MAX = 700;
const MAX_TOP_K = 20;
const DEFAULT_MIN_SCORE = 0.1;
/** specs/memory.allium config.search_host_timeout. */
const HOST_TIMEOUT_MS = 15_000;
const HOST_POLL_MS = 500;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '')}"`).join(' AND ');
}

function bm25ToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  return rank < 0 ? -rank / (1 + -rank) : 1 / (1 + rank);
}

function openDb(): Database | null {
  if (!fs.existsSync(INDEX_PATH)) return null;
  try {
    return new Database(INDEX_PATH, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Translate an indexed path to an absolute container path.
 *
 * The group's own memory: groups/<folder>/X/Y  →  /workspace/agent/X/Y
 * An indexed mount:       extra/<mount>/X/Y    →  /workspace/extra/<mount>/X/Y
 *
 * The host stores a mount's files as the container sees them, so the second
 * is direct; a path that would normalise outside /workspace/extra is refused.
 * (The older `../…` form, matched against container.json's memoryIndexDirs,
 * is gone: that field never reached container.json, so it never matched.)
 */
export function resolveIndexedPath(repoPath: string): string | null {
  if (repoPath.startsWith('extra/')) {
    const abs = path.posix.normalize(path.posix.join('/workspace', repoPath));
    return abs.startsWith('/workspace/extra/') ? abs : null;
  }
  if (repoPath.startsWith('../')) return null;
  const stripped = repoPath.replace(/^groups\/[^/]+\//, '');
  return path.join('/workspace/agent', stripped);
}

function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return undefined;
  const result: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!key) continue;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      result[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (raw === 'null' || raw === '') {
      result[key] = null;
    } else if (raw === 'true') {
      result[key] = true;
    } else if (raw === 'false') {
      result[key] = false;
    } else {
      result[key] = raw;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export interface SearchArgs {
  query: string;
  topK: number;
  pathPrefix?: string;
  source?: string;
  minScore: number;
}

/** Keyword-only search of the read-only index — the fallback when the host does not answer. */
export function keywordSearch(db: Database, args: SearchArgs): unknown[] {
  const ftsQuery = buildFtsQuery(args.query);
  if (!ftsQuery) return [];

  // Filters narrow the candidates before LIMIT, so matches inside them are
  // never crowded out by better-ranked matches outside them.
  const conditions = [`${FTS_TABLE} MATCH ?`];
  const params: (string | number)[] = [ftsQuery];
  if (args.source) {
    conditions.push('source = ?');
    params.push(args.source);
  }
  if (args.pathPrefix) {
    conditions.push('substr(path, 1, length(?)) = ?');
    params.push(args.pathPrefix, args.pathPrefix);
  }

  const rows = db
    .query<
      { path: string; source: string; start_line: number; end_line: number; text: string; rank: number },
      (string | number)[]
    >(`SELECT path, source, start_line, end_line, text, bm25(${FTS_TABLE}) AS rank` + `  FROM ${FTS_TABLE}` + ` WHERE ${conditions.join(' AND ')}` + ` ORDER BY rank ASC LIMIT ?`)
    .all(...params, args.topK * 4);

  return rows
    .map((r) => ({
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      score: bm25ToScore(r.rank),
      snippet: truncate(r.text, SNIPPET_MAX),
      source: r.source,
    }))
    .filter((r) => r.score >= args.minScore)
    .slice(0, args.topK);
}

type HostAnswer = { mode: string; results: unknown[] } | { error: string };

/** Ask the host for a hybrid search; null when it does not answer in time. */
async function askHost(args: SearchArgs, timeoutMs: number, signal?: AbortSignal): Promise<HostAnswer | null> {
  const requestId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({
      action: 'memory_search_request',
      requestId,
      query: args.query,
      top_k: args.topK,
      path_prefix: args.pathPrefix,
      source: args.source,
    }),
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const row = findCliResponse(requestId);
    if (row) {
      markCompleted([row.id]);
      return JSON.parse(row.content) as HostAnswer;
    }
    try {
      await sleep(HOST_POLL_MS, undefined, { signal });
    } catch {
      return null;
    }
  }
  return null;
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createMemorySearch(hostTimeoutMs = HOST_TIMEOUT_MS): McpToolDefinition {
  return {
    tool: {
      name: 'memory_search',
      description:
        'Search your personal knowledge base (memory files, research documents, notes). Use when the user references something you may have notes on, or when background context would improve your answer.\n\nMatches by meaning and by keyword. Returns { mode, results }: ranked results with path, line range, score, and snippet; mode is "hybrid", or "keyword" when meaning-based search was unavailable (then every query word must appear). Use memory_get_file_content to fetch the full content of a result.',
      inputSchema: {
        type: 'object' as const,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          top_k: { type: 'number', description: 'Max results (default 6, max 20).' },
          path_prefix: {
            type: 'string',
            description: 'Filter to a path subtree, e.g. "groups/dm-with-alanz/zettel/notes/".',
          },
          source: {
            type: 'string',
            description:
              'Filter by source: "memory" (memory/), "zettel" (the Zettelkasten, zettel/), or a mount name such as "org".',
          },
          min_score: { type: 'number', description: 'Keyword mode only: min relevance score 0–1 (default 0.1).' },
        },
      },
    },
    async handler(args, context) {
      const query = args.query as string;
      const searchArgs: SearchArgs = {
        query,
        topK: typeof args.top_k === 'number' ? Math.min(args.top_k, MAX_TOP_K) : 6,
        pathPrefix: (args.path_prefix as string | undefined) || undefined,
        source: (args.source as string | undefined) || undefined,
        minScore: typeof args.min_score === 'number' ? args.min_score : DEFAULT_MIN_SCORE,
      };

      const answer = await askHost(searchArgs, hostTimeoutMs, context?.signal);
      if (answer && 'mode' in answer && answer.mode !== 'unavailable') {
        return textResult({ mode: answer.mode, results: answer.results });
      }
      if (answer && 'error' in answer) console.error(`[mcp-tools] memory_search: host error: ${answer.error}`);

      const db = openDb();
      if (!db) return textResult({ mode: 'keyword', results: [] });
      try {
        return textResult({ mode: 'keyword', results: keywordSearch(db, searchArgs) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      } finally {
        db.close();
      }
    },
  };
}

export const memorySearch = createMemorySearch();

export const memoryGetFileContent: McpToolDefinition = {
  tool: {
    name: 'memory_get_file_content',
    description:
      'Read the full content of a specific file from your knowledge base. Use the path from memory_search results.',
    inputSchema: {
      type: 'object' as const,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Repo-relative path of the file (from memory_search result).' },
        parse_frontmatter: { type: 'boolean', description: 'Parse YAML frontmatter (default: true).' },
      },
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    const parseFm = args.parse_frontmatter !== false;

    const db = openDb();
    if (!db) {
      return { content: [{ type: 'text' as const, text: 'Error: memory index not available' }], isError: true };
    }

    try {
      const row = db
        .query<{ path: string; hash: string }, [string]>('SELECT path, hash FROM files WHERE path = ?')
        .get(filePath);

      db.close();

      if (!row) {
        return { content: [{ type: 'text' as const, text: `Error: file not indexed: ${filePath}` }], isError: true };
      }

      const absPath = resolveIndexedPath(filePath);
      if (!absPath) {
        return {
          content: [{ type: 'text' as const, text: `Error: cannot resolve container path for: ${filePath}` }],
          isError: true,
        };
      }

      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        return { content: [{ type: 'text' as const, text: `Error: file not readable: ${filePath}` }], isError: true };
      }

      const result: Record<string, unknown> = { path: filePath, content, size: content.length, indexed: true };
      if (parseFm) result.frontmatter = parseFrontmatter(content);

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      db.close();
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
};

export const memoryListFiles: McpToolDefinition = {
  tool: {
    name: 'memory_list_files',
    description: 'List all indexed files in your knowledge base.',
    inputSchema: {
      type: 'object' as const,
      required: [],
      properties: {
        path_prefix: { type: 'string', description: 'Restrict listing to files under this path prefix.' },
        source: { type: 'string', description: 'Restrict listing to files from a named source.' },
        limit: { type: 'number', description: 'Maximum number of files to return.' },
        order_by: { type: 'string', description: 'Sort order: mtime | path | size.' },
        parse_frontmatter: {
          type: 'boolean',
          description: 'Parse and include YAML frontmatter (limit ≤ 50 when true).',
        },
      },
    },
  },
  async handler(args) {
    const pathPrefix = args.path_prefix as string | undefined;
    const source = args.source as string | undefined;
    const parseFm = args.parse_frontmatter === true;
    const orderBy = (args.order_by as string | undefined) ?? 'mtime';
    const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, parseFm ? 50 : 200);

    const db = openDb();
    if (!db) return { content: [{ type: 'text' as const, text: JSON.stringify([]) }] };

    try {
      const orderCol = orderBy === 'size' ? 'size' : orderBy === 'path' ? 'path' : 'mtime';
      const orderDir = orderBy === 'path' ? 'ASC' : 'DESC';
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (pathPrefix) {
        conditions.push('path LIKE ?');
        params.push(`${pathPrefix}%`);
      }
      if (source) {
        conditions.push('source = ?');
        params.push(source);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db
        .query<
          { path: string; mtime: number; size: number },
          (string | number)[]
        >(`SELECT path, mtime, size FROM files ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ?`)
        .all(...params, limit);

      db.close();

      const files = rows.map((r) => {
        const entry: Record<string, unknown> = { path: r.path, mtime: r.mtime, size: r.size, indexed: true };
        if (parseFm) {
          try {
            const absPath = resolveIndexedPath(r.path);
            if (absPath) {
              const content = fs.readFileSync(absPath, 'utf-8');
              entry.frontmatter = parseFrontmatter(content);
            }
          } catch {}
        }
        return entry;
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify(files) }] };
    } catch (err) {
      db.close();
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
};

registerTools([memorySearch, memoryGetFileContent, memoryListFiles]);
