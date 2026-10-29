// Spec: specs/memory.allium — surface MemoryMcpTools
// Obligations: surface-provides.MemoryMcpTools, surface-actor.MemoryMcpTools
//
// Verifies that the three memory MCP tool definitions are exported with the
// correct names, and that specialist containers exclude them.
//
// TODO: create container/agent-runner/src/mcp-tools/memory.ts with tool definitions
// for memory_search, memory_get_file_content, and memory_list_files. Gate
// the `registerTools([...])` call on `!isSpecialist` so specialist containers
// do not receive these tools (spec guidance on MemorySearched, MemoryFileRead,
// MemoryListed).

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

// TODO: export individual tool definitions from memory.ts so tests can inspect them
import {
  createMemorySearch,
  groupByFile,
  keywordSearch,
  memoryGetFileContent,
  memoryListFiles,
  memorySearch,
  resolveIndexedPath,
} from './memory.js';

const EXPECTED_TOOL_NAMES = ['memory_search', 'memory_get_file_content', 'memory_list_files'] as const;

// ── surface-provides.MemoryMcpTools ──────────────────────────────────────────

describe('MemoryMcpTools — tool names match surface provides', () => {
  it('memory_search tool is declared with the correct name', () => {
    expect(memorySearch.tool.name).toBe('memory_search');
  });

  it('memory_get_file_content tool is declared with the correct name', () => {
    expect(memoryGetFileContent.tool.name).toBe('memory_get_file_content');
  });

  it('memory_list_files tool is declared with the correct name', () => {
    expect(memoryListFiles.tool.name).toBe('memory_list_files');
  });

  it('all three surface operations are present', () => {
    const names = [memorySearch.tool.name, memoryGetFileContent.tool.name, memoryListFiles.tool.name];
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });
});

// ── Tool input schemas ────────────────────────────────────────────────────────

describe('MemoryMcpTools — tool input schemas', () => {
  // The `group` param was dropped (see "drop group param from MCP tools"): each
  // session is already scoped to its own agent group, which the host resolves,
  // so the tools never take a group argument.
  it('memory_search accepts query and optional top_k / path_prefix, no group', () => {
    const props = memorySearch.tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('query');
    expect(props).toHaveProperty('top_k');
    expect(props).toHaveProperty('path_prefix');
    expect(props).not.toHaveProperty('group');
  });

  it('memory_get_file_content accepts path and optional parse_frontmatter, no group', () => {
    const props = memoryGetFileContent.tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('path');
    expect(props).toHaveProperty('parse_frontmatter');
    expect(props).not.toHaveProperty('group');
  });

  it('memory_list_files accepts optional list params, no group', () => {
    const props = memoryListFiles.tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('path_prefix');
    expect(props).toHaveProperty('limit');
    expect(props).toHaveProperty('parse_frontmatter');
    expect(props).not.toHaveProperty('group');
  });
});

// ── surface-actor.MemoryMcpTools — specialist gating note ────────────────────
//
// The spec (guidance on MemorySearched, MemoryFileRead, MemoryListed) states that
// memory tools must not be registered in specialist containers. The gating is
// implemented at import time in mcp-tools/index.ts:
//
//   if (!isSpecialist) { await import('./memory.js'); }
//
// An integration test for specialist exclusion requires a way to reset the tool
// registry between test runs. Add `clearRegisteredTools()` to server.ts and
// expand this suite once that export exists.
//
// For now, the host-side session-group mismatch tests in src/memory/memory.test.ts
// cover the actor restriction: all three rule handlers throw when
// session.agent_group_id !== group_id.

// The host stores an indexed mount's files at the path the container sees
// them (`extra/<mount>/…`), so a hit maps straight to its mount point; the
// group's own memory keeps its repo-relative form.
describe('resolveIndexedPath', () => {
  it('maps an indexed mount file to its mount point', () => {
    expect(resolveIndexedPath('extra/org/gtd.org')).toBe('/workspace/extra/org/gtd.org');
    expect(resolveIndexedPath('extra/org/projects/nanoclaw.org')).toBe('/workspace/extra/org/projects/nanoclaw.org');
  });

  it("maps the group's own memory into its workspace", () => {
    expect(resolveIndexedPath('groups/dm-with-alanz/memory/notes/x.md')).toBe('/workspace/agent/memory/notes/x.md');
    // A memory provider reads the group it serves through that group's mount.
    expect(resolveIndexedPath('groups/dm-with-alanz/zettel/notes/MEM-x.md', '/workspace/extra/main')).toBe(
      '/workspace/extra/main/zettel/notes/MEM-x.md',
    );
  });

  it('refuses a path that would leave /workspace/extra, and the old ../ form', () => {
    expect(resolveIndexedPath('extra/../agent/secrets')).toBeNull();
    expect(resolveIndexedPath('extra/org/../../../etc/passwd')).toBeNull();
    expect(resolveIndexedPath('../Sync/org/gtd.org')).toBeNull();
  });
});

// ── memory_search: host round-trip, keyword fallback ─────────────────────────
// specs/memory.allium, MemorySearched: the host answers with its hybrid search;
// with no answer in time the container searches keyword-only itself, with the
// filters narrowing the candidates before ranking.

describe('keywordSearch', () => {
  const NOTES = 'groups/g/zettel/notes/';
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      'CREATE VIRTUAL TABLE chunks_fts USING fts5(text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED)',
    );
    const insert = db.prepare(
      'INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, 1, 1)',
    );
    for (let i = 0; i < 40; i++) insert.run('emacs emacs emacs emacs', `org-${i}`, `extra/org/f${i}.org`, 'org', 'm');
    insert.run('emacs and a lot of other words about other things', 'n1', `${NOTES}a.md`, 'zettel', 'm');
    insert.run('emacs once among many unrelated words here', 'n2', `${NOTES}b.md`, 'zettel', 'm');
  });
  afterEach(() => db.close());

  const args = { query: 'emacs', topK: 6, minScore: 0 };

  it('path_prefix matches are not crowded out by better-ranked matches elsewhere', () => {
    const results = keywordSearch(db, { ...args, pathPrefix: NOTES }) as Array<{ path: string }>;
    expect(results.map((r) => r.path).sort()).toEqual([`${NOTES}a.md`, `${NOTES}b.md`]);
  });

  it('source filters in SQL; path_prefix is literal, not a LIKE pattern', () => {
    expect(keywordSearch(db, { ...args, source: 'zettel' })).toHaveLength(2);
    expect(keywordSearch(db, { ...args, pathPrefix: 'groups/g/zettel/n_tes/' })).toEqual([]);
  });

  it('leaves superseded notes out unless asked, once the index records them', () => {
    // An index from before the column: nothing is known to be superseded.
    expect(keywordSearch(db, { ...args, source: 'zettel' })).toHaveLength(2);
    db.exec('CREATE TABLE files (path TEXT PRIMARY KEY, superseded INTEGER NOT NULL DEFAULT 0)');
    db.prepare('INSERT INTO files (path, superseded) VALUES (?, 1), (?, 0)').run(`${NOTES}a.md`, `${NOTES}b.md`);
    const paths = (r: unknown[]) => (r as Array<{ path: string }>).map((x) => x.path).sort();
    expect(paths(keywordSearch(db, { ...args, source: 'zettel' }))).toEqual([`${NOTES}b.md`]);
    expect(paths(keywordSearch(db, { ...args, source: 'zettel', includeSuperseded: true }))).toEqual([
      `${NOTES}a.md`,
      `${NOTES}b.md`,
    ]);
  });
});

describe('groupByFile (keyword fallback)', () => {
  const chunk = (startLine: number, endLine: number, score: number, snippet = 'x'.repeat(700)) => ({
    path: 'a.md',
    source: 'zettel',
    startLine,
    endLine,
    score,
    snippet,
  });

  it('one result per file: overlapping chunks merge, 3 locations at most, the rest counted', () => {
    const results = groupByFile(
      [
        chunk(36, 47, 0.8, 'best'),
        chunk(44, 59, 0.6),
        chunk(100, 110, 0.7),
        chunk(200, 210, 0.5),
        chunk(300, 310, 0.4),
      ],
      6,
    ) as Array<{
      score: number;
      locations: Array<{ startLine: number; endLine: number; snippet: string }>;
      moreLocations: number;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(0.8);
    expect(results[0]!.locations.map((l) => [l.startLine, l.endLine])).toEqual([
      [36, 59],
      [100, 110],
      [200, 210],
    ]);
    expect(results[0]!.locations.map((l) => l.snippet.length)).toEqual([4, 200, 200]);
    expect(results[0]!.moreLocations).toBe(1);
  });
});

describe('memory_search handler', () => {
  beforeEach(() => initTestSessionDb());
  afterEach(() => closeSessionDb());

  function request(): Record<string, unknown> | undefined {
    const row = getUndeliveredMessages().find((m) => m.kind === 'system');
    return row && JSON.parse(row.content);
  }

  function answer(content: Record<string, unknown>): void {
    getInboundDb()
      .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
      .run(`memory-search-resp-${content.requestId}`, 'system', new Date().toISOString(), JSON.stringify(content));
  }

  async function hostAnswers(reply: (requestId: string) => Record<string, unknown>): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const req = request();
      if (req) return answer(reply(req.requestId as string));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('no memory_search_request written');
  }

  it("asks the host with the filters and returns the host's hybrid answer", async () => {
    const tool = createMemorySearch(3_000);
    const call = tool.handler({ query: 'emacs', top_k: 50, path_prefix: 'groups/g/', source: 'zettel' });
    await hostAnswers((requestId) => ({
      type: 'memory_search_response',
      requestId,
      mode: 'hybrid',
      results: [{ path: 'groups/g/a.md' }],
    }));
    const result = await call;
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      mode: 'hybrid',
      results: [{ path: 'groups/g/a.md' }],
    });
    expect(request()).toMatchObject({
      action: 'memory_search_request',
      query: 'emacs',
      top_k: 20,
      path_prefix: 'groups/g/',
      source: 'zettel',
    });
    // No min_score from the agent: none is sent, so the host applies its own default.
    expect(request()).not.toHaveProperty('min_score');
  });

  it("forwards the agent's own min_score to the host", async () => {
    const call = createMemorySearch(3_000).handler({ query: 'emacs', min_score: 0.5 });
    await hostAnswers((requestId) => ({ type: 'memory_search_response', requestId, mode: 'hybrid', results: [] }));
    await call;
    expect(request()?.min_score).toBe(0.5);
  });

  it('falls back to keyword mode when the host has no index for the group', async () => {
    const tool = createMemorySearch(3_000);
    const call = tool.handler({ query: 'emacs' });
    await hostAnswers((requestId) => ({ type: 'memory_search_response', requestId, mode: 'unavailable', results: [] }));
    expect(JSON.parse(((await call).content[0] as { text: string }).text).mode).toBe('keyword');
  });

  it('falls back to keyword mode when the host does not answer in time', async () => {
    const started = Date.now();
    const result = await createMemorySearch(100).handler({ query: 'emacs' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.parse((result.content[0] as { text: string }).text).mode).toBe('keyword');
    expect(request()?.action).toBe('memory_search_request');
  });
});
