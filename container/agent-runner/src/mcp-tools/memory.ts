/**
 * Memory MCP tools: memory_search, memory_get_file_content, memory_list_files.
 *
 * Only available in non-specialist containers. The host maintains a per-group
 * SQLite index at data/v2-memory/<group_id>/index.db, mounted read-only at
 * /workspace/memory/index.db. Tools query it directly via bun:sqlite — no
 * host round-trip needed for reads.
 *
 * Search uses FTS5 keyword matching (always available). The host also writes
 * vector embeddings, but loading the sqlite-vec extension in the container
 * requires the native binary; we fall back gracefully if unavailable.
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const INDEX_PATH = '/workspace/memory/index.db';
const FTS_TABLE = 'chunks_fts';
const SNIPPET_MAX = 700;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '')}"`).join(' AND ');
}

function bm25ToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  return rank < 0 ? (-rank) / (1 + (-rank)) : 1 / (1 + rank);
}

function openDb(): Database | null {
  if (!fs.existsSync(INDEX_PATH)) return null;
  try {
    return new Database(INDEX_PATH, { readonly: true });
  } catch {
    return null;
  }
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
      result[key] = raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
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

export const memorySearch: McpToolDefinition = {
  tool: {
    name: 'memory_search',
    description:
      'Search the agent group memory index using a natural language query. Returns ranked results from indexed markdown and org files.',
    inputSchema: {
      type: 'object' as const,
      required: ['group', 'query'],
      properties: {
        group: { type: 'string', description: 'The agent group folder name to search within.' },
        query: { type: 'string', description: 'Natural language search query.' },
        top_k: { type: 'number', description: 'Maximum number of results to return (default: 6).' },
      },
    },
  },
  async handler(args) {
    const query = args.query as string;
    const topK = typeof args.top_k === 'number' ? Math.min(args.top_k, 20) : 6;

    const db = openDb();
    if (!db) return { content: [{ type: 'text' as const, text: JSON.stringify([]) }] };

    try {
      const ftsQuery = buildFtsQuery(query);
      if (!ftsQuery) {
        db.close();
        return { content: [{ type: 'text' as const, text: JSON.stringify([]) }] };
      }

      const rows = db.query<
        { id: string; path: string; source: string; start_line: number; end_line: number; text: string; rank: number },
        [string, number]
      >(
        `SELECT id, path, source, start_line, end_line, text, bm25(${FTS_TABLE}) AS rank` +
        `  FROM ${FTS_TABLE}` +
        ` WHERE ${FTS_TABLE} MATCH ?` +
        ` ORDER BY rank ASC LIMIT ?`,
      ).all(ftsQuery, topK * 4);

      const results = rows
        .map((r) => ({
          path: r.path,
          startLine: r.start_line,
          endLine: r.end_line,
          score: bm25ToScore(r.rank),
          snippet: truncate(r.text, SNIPPET_MAX),
          source: r.source,
        }))
        .filter((r) => r.score >= 0.1)
        .slice(0, topK);

      db.close();
      return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] };
    } catch (err) {
      db.close();
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  },
};

export const memoryGetFileContent: McpToolDefinition = {
  tool: {
    name: 'memory_get_file_content',
    description: 'Read the full content of a specific indexed memory file by path.',
    inputSchema: {
      type: 'object' as const,
      required: ['group', 'path'],
      properties: {
        group: { type: 'string', description: 'The agent group folder name.' },
        path: { type: 'string', description: 'Repo-relative path of the file to retrieve.' },
        parse_frontmatter: { type: 'boolean', description: 'Whether to parse and return YAML frontmatter (default: true).' },
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
      const row = db.query<{ path: string; hash: string }, [string]>(
        'SELECT path, hash FROM files WHERE path = ?',
      ).get(filePath);

      db.close();

      if (!row) {
        return { content: [{ type: 'text' as const, text: `Error: file not indexed: ${filePath}` }], isError: true };
      }

      // File lives under /workspace/agent relative to the container.
      // The repo-relative path is groups/<folder>/memory/...
      // Strip the groups/<folder>/ prefix to get the workspace-agent-relative path.
      const stripped = filePath.replace(/^groups\/[^/]+\//, '');
      const absPath = path.join('/workspace/agent', stripped);

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
    description: 'List indexed files in the agent group memory workspace.',
    inputSchema: {
      type: 'object' as const,
      required: ['group'],
      properties: {
        group: { type: 'string', description: 'The agent group folder name.' },
        path_prefix: { type: 'string', description: 'Restrict listing to files under this path prefix.' },
        source: { type: 'string', description: 'Restrict listing to files from a named source.' },
        limit: { type: 'number', description: 'Maximum number of files to return.' },
        order_by: { type: 'string', description: 'Sort order: mtime | path | size.' },
        parse_frontmatter: { type: 'boolean', description: 'Whether to parse and include YAML frontmatter (limit ≤ 50 when true).' },
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

      if (pathPrefix) { conditions.push('path LIKE ?'); params.push(`${pathPrefix}%`); }
      if (source) { conditions.push('source = ?'); params.push(source); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.query<{ path: string; mtime: number; size: number }, (string | number)[]>(
        `SELECT path, mtime, size FROM files ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ?`,
      ).all(...params, limit);

      db.close();

      const files = rows.map((r) => {
        const entry: Record<string, unknown> = { path: r.path, mtime: r.mtime, size: r.size, indexed: true };
        if (parseFm) {
          try {
            const stripped = r.path.replace(/^groups\/[^/]+\//, '');
            const content = fs.readFileSync(path.join('/workspace/agent', stripped), 'utf-8');
            entry.frontmatter = parseFrontmatter(content);
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
