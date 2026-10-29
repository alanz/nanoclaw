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
/** Snippets of a result's locations after its best one. */
const OTHER_SNIPPET_MAX = 200;
/** specs/memory.allium config.search_locations_per_file. */
const LOCATIONS_PER_FILE = 3;
/** Chunk candidates per requested file: grouping by file uses some up. */
const CANDIDATES_PER_RESULT = 8;
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
 * The indexed group's memory: groups/<folder>/X/Y  →  <workspace>/X/Y, where
 * <workspace> is NANOCLAW_MEMORY_WORKSPACE — /workspace/agent for the group's
 * own sessions, or for a memory-provider specialist the read-only mount of the
 * group it serves (e.g. /workspace/extra/main).
 * An indexed mount:       extra/<mount>/X/Y    →  /workspace/extra/<mount>/X/Y
 *
 * The host stores a mount's files as the container sees them, so the second
 * is direct; a path that would normalise outside /workspace/extra is refused.
 * (The older `../…` form, matched against container.json's memoryIndexDirs,
 * is gone: that field never reached container.json, so it never matched.)
 */
export function resolveIndexedPath(
  repoPath: string,
  workspace = process.env.NANOCLAW_MEMORY_WORKSPACE || '/workspace/agent',
): string | null {
  if (repoPath.startsWith('extra/')) {
    const abs = path.posix.normalize(path.posix.join('/workspace', repoPath));
    return abs.startsWith('/workspace/extra/') ? abs : null;
  }
  if (repoPath.startsWith('../')) return null;
  const stripped = repoPath.replace(/^groups\/[^/]+\//, '');
  return path.join(workspace, stripped);
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
  /** Include superseded notes; left out by default. */
  includeSuperseded?: boolean;
  /** Applied by the keyword fallback. */
  minScore: number;
  /** The caller's own min_score, if any — the host applies its default otherwise. */
  requestedMinScore?: number;
}

/** Keyword-only search of the read-only index — the fallback when the host does not answer. */
function hasSupersededColumn(db: Database): boolean {
  return (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).some((c) => c.name === 'superseded');
}

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
  // An index from before the column has none; then nothing is marked superseded.
  if (!args.includeSuperseded && hasSupersededColumn(db)) {
    conditions.push('path NOT IN (SELECT path FROM files WHERE superseded = 1)');
  }

  const rows = db
    .query<
      { path: string; source: string; start_line: number; end_line: number; text: string; rank: number },
      (string | number)[]
    >(`SELECT path, source, start_line, end_line, text, bm25(${FTS_TABLE}) AS rank` + `  FROM ${FTS_TABLE}` + ` WHERE ${conditions.join(' AND ')}` + ` ORDER BY rank ASC LIMIT ?`)
    .all(...params, args.topK * CANDIDATES_PER_RESULT);

  const chunks = rows
    .map((r) => ({
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      score: bm25ToScore(r.rank),
      snippet: truncate(r.text, SNIPPET_MAX),
      source: r.source,
    }))
    .filter((r) => r.score >= args.minScore);
  return groupByFile(chunks, args.topK);
}

interface SearchLocation {
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

/**
 * One result per file, as the host returns them (src/memory/hybrid.ts
 * groupByFile, restated: host and container share no modules). Files rank by
 * their best chunk; overlapping chunks merge into one location; at most
 * LOCATIONS_PER_FILE listed, best first, the rest counted.
 */
export function groupByFile(
  chunks: ReadonlyArray<SearchLocation & { path: string; source: string }>,
  limit: number,
): unknown[] {
  const byPath = new Map<string, { source: string; chunks: SearchLocation[] }>();
  for (const c of chunks) {
    const entry = byPath.get(c.path) ?? { source: c.source, chunks: [] };
    entry.chunks.push({ startLine: c.startLine, endLine: c.endLine, score: c.score, snippet: c.snippet });
    byPath.set(c.path, entry);
  }

  const files: Array<{
    path: string;
    source: string;
    score: number;
    locations: SearchLocation[];
    moreLocations: number;
  }> = [];
  for (const [filePath, entry] of byPath) {
    const merged: SearchLocation[] = [];
    for (const c of [...entry.chunks].sort((a, b) => a.startLine - b.startLine)) {
      const last = merged[merged.length - 1];
      if (last && c.startLine <= last.endLine) {
        last.endLine = Math.max(last.endLine, c.endLine);
        if (c.score > last.score) {
          last.score = c.score;
          last.snippet = c.snippet;
        }
      } else {
        merged.push({ ...c });
      }
    }
    merged.sort((a, b) => b.score - a.score);
    const locations = merged.slice(0, LOCATIONS_PER_FILE).map((l, i) => ({
      ...l,
      snippet: i === 0 ? l.snippet : truncate(l.snippet, OTHER_SNIPPET_MAX),
    }));
    files.push({
      path: filePath,
      source: entry.source,
      score: locations[0]!.score,
      locations,
      moreLocations: merged.length - locations.length,
    });
  }
  return files.sort((a, b) => b.score - a.score).slice(0, limit);
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
      min_score: args.requestedMinScore,
      include_superseded: args.includeSuperseded,
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
        'Search your personal knowledge base (memory files, research documents, notes). Use when the user references something you may have notes on, or when background context would improve your answer.\n\nMatches by meaning and by keyword. Returns { mode, results }: one result per file, ranked — path, source, score, and up to 3 locations (line range, score, snippet; best first), with moreLocations counting matches left out; mode is "hybrid", or "keyword" when meaning-based search was unavailable (then every query word must appear). Use memory_get_file_content to fetch the full content of a result.',
      inputSchema: {
        type: 'object' as const,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          top_k: { type: 'number', description: 'Max files returned (default 6, max 20).' },
          path_prefix: {
            type: 'string',
            description: 'Filter to a path subtree, e.g. "groups/dm-with-alanz/zettel/notes/".',
          },
          source: {
            type: 'string',
            description:
              'Filter by source: "memory" (memory/), "zettel" (the Zettelkasten, zettel/), "zotero" (the Zotero library, zotero-md/, where synced), or a mount name such as "org".',
          },
          min_score: {
            type: 'number',
            description: 'Min relevance score 0–1 (default 0.35 in hybrid mode, 0.1 in keyword mode).',
          },
          include_superseded: {
            type: 'boolean',
            description:
              'Include Zettelkasten notes that have been superseded (default false: current knowledge only). Set it when asking what was believed earlier.',
          },
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
        requestedMinScore: typeof args.min_score === 'number' ? args.min_score : undefined,
        includeSuperseded: args.include_superseded === true,
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
        // A literal, case-sensitive prefix, as memory_search matches it. LIKE
        // would read `_`/`%` in the prefix as wildcards and ignore ASCII case.
        conditions.push('instr(path, ?) = 1');
        params.push(pathPrefix);
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
