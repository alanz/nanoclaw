// Spec: specs/memory.allium — MemoryFileRead, MemoryListed, MemoryListParams,
// config.search_host_timeout. Claimed from src/memory/spec/ with `covered`.
//
// Get and list read the group's index, mounted read-only at
// /workspace/memory/index.db, and the indexed files in the workspace the host
// names (NANOCLAW_MEMORY_WORKSPACE). Here the mount point is redirected to a
// temporary index built with the host's schema, and the workspace to a
// temporary directory.

import * as realSqlite from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const INDEX_PATH = '/workspace/memory/index.db';
const tmp = realFs.realpathSync(realFs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-reads-')));
const indexFile = path.join(tmp, 'index.db');
const workspace = path.join(tmp, 'workspace');

// Captured before mocking: the namespaces are live and would see the mocks.
const RealDatabase = realSqlite.Database;
const realExistsSync = realFs.existsSync;
const sqliteExports = { ...realSqlite };
const fsExports = { ...realFs };
class RedirectedDatabase extends RealDatabase {
  constructor(file?: string, options?: ConstructorParameters<typeof RealDatabase>[1]) {
    super(file === INDEX_PATH ? indexFile : file, options);
  }
}
mock.module('bun:sqlite', () => ({ ...sqliteExports, Database: RedirectedDatabase }));
mock.module('node:fs', () => ({
  ...fsExports,
  existsSync: (p: realFs.PathLike) => realExistsSync(p === INDEX_PATH ? indexFile : p),
}));

const { createMemorySearch, memoryGetFileContent, memoryListFiles } = await import('./memory.js');
const { closeSessionDb, initTestSessionDb } = await import('../mailbox/sqlite/connection.js');
const { getUndeliveredMessages } = await import('../db/messages-out.js');

const NOTE = 'groups/main/zettel/notes/a.md';
const MEM = 'groups/main/memory/b.md';
const ORG = 'extra/org/gtd.org';

function write(rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  realFs.mkdirSync(path.dirname(abs), { recursive: true });
  realFs.writeFileSync(abs, content);
}

beforeAll(() => {
  realFs.mkdirSync(workspace, { recursive: true });
  write('zettel/notes/a.md', '---\ntitle: Aardvarks\ntags: [animals, africa]\n---\nAardvarks dig.\n');
  write('memory/b.md', '---\ntitle: Bees\n---\nBees hum.\n');
  write('memory/unindexed.md', 'On disk but not in the index.\n');

  const db = new RealDatabase(indexFile);
  db.exec(
    `CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'memory', hash TEXT NOT NULL,
       mtime INTEGER NOT NULL, size INTEGER NOT NULL, superseded INTEGER NOT NULL DEFAULT 0)`,
  );
  const insert = db.prepare('INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)');
  insert.run(NOTE, 'zettel', 'h1', 3000, 10);
  insert.run(MEM, 'memory', 'h2', 1000, 30);
  insert.run(ORG, 'org', 'h3', 2000, 20);
  db.exec(
    'CREATE VIRTUAL TABLE chunks_fts USING fts5(text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED)',
  );
  db.prepare(
    "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES ('Aardvarks dig.', 'c1', ?, 'zettel', 'm', 5, 5)",
  ).run(NOTE);
  // Other chunks, so the term is rare enough to score above the keyword floor.
  const other = db.prepare(
    "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES ('Bees hum all day.', ?, ?, 'memory', 'm', 1, 1)",
  );
  for (let i = 0; i < 20; i++) other.run(`o${i}`, MEM);
  db.close();
});
afterAll(() => realFs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  process.env.NANOCLAW_MEMORY_WORKSPACE = workspace;
});
afterEach(() => {
  delete process.env.NANOCLAW_MEMORY_WORKSPACE;
});

function json(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse((result.content[0] as { text: string }).text);
}

async function list(args: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  return json(await memoryListFiles.handler(args)) as Array<Record<string, unknown>>;
}

describe('memory_get_file_content', () => {
  it('memory_get_file_content returns an indexed file read from the workspace, with its frontmatter by default', async () => {
    const result = await memoryGetFileContent.handler({ path: NOTE });
    expect(result.isError).toBeFalsy();
    const content = '---\ntitle: Aardvarks\ntags: [animals, africa]\n---\nAardvarks dig.\n';
    expect(json(result)).toEqual({
      path: NOTE,
      content,
      size: content.length,
      indexed: true,
      frontmatter: { title: 'Aardvarks', tags: ['animals', 'africa'] },
    });
    const bare = json(await memoryGetFileContent.handler({ path: NOTE, parse_frontmatter: false }));
    expect(bare).not.toHaveProperty('frontmatter');
  });

  it('memory_get_file_content refuses a path the index does not hold, even when the file is on disk', async () => {
    const result = await memoryGetFileContent.handler({ path: 'groups/main/memory/unindexed.md' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      'Error: file not indexed: groups/main/memory/unindexed.md',
    );
  });
});

describe('memory_list_files', () => {
  it('memory_list_files lists every indexed file, newest first, when given no params', async () => {
    expect((await list({})).map((f) => f.path)).toEqual([NOTE, ORG, MEM]);
  });

  it('memory_list_files applies each list param: path_prefix, source, limit, order_by and parse_frontmatter', async () => {
    expect((await list({ path_prefix: 'groups/main/' })).map((f) => f.path)).toEqual([NOTE, MEM]);
    expect((await list({ source: 'org' })).map((f) => f.path)).toEqual([ORG]);
    expect((await list({ limit: 1 })).map((f) => f.path)).toEqual([NOTE]);
    expect((await list({ order_by: 'path' })).map((f) => f.path)).toEqual([ORG, MEM, NOTE]);
    expect((await list({ order_by: 'size' })).map((f) => f.path)).toEqual([MEM, ORG, NOTE]);
    const withFm = await list({ path_prefix: 'groups/main/', parse_frontmatter: true });
    expect(withFm.map((f) => f.frontmatter)).toEqual([
      { title: 'Aardvarks', tags: ['animals', 'africa'] },
      { title: 'Bees' },
    ]);
    expect((await list({})).every((f) => !('frontmatter' in f))).toBe(true);
  });

  it('memory_list_files: equal list params give equal listings', async () => {
    const params = { path_prefix: 'groups/', source: 'memory', limit: 5, order_by: 'path', parse_frontmatter: true };
    const a = await list({ ...params });
    const b = await list(JSON.parse(JSON.stringify(params)));
    expect(a).toEqual(b);
    expect(a.map((f) => f.path)).toEqual([MEM]);
  });

  // DIVERGENCE (specs/memory.allium MemoryListParams.path_prefix, "restrict
  // listing to files under this path prefix"): the listing matches the prefix
  // with SQL LIKE, so `_` and `%` in it are wildcards and files outside the
  // prefix are listed. memory_search (host and keyword fallback) matches it
  // literally. Expected to fail until the listing does the same.
  it.failing('memory_list_files path_prefix is literal: LIKE wildcards in it match nothing extra', async () => {
    expect((await list({ path_prefix: 'groups/main/m_mory/' })).map((f) => f.path)).toEqual([]);
  });
});

describe('memory_search host timeout', () => {
  beforeEach(() => initTestSessionDb());
  afterEach(() => {
    setSystemTime();
    closeSessionDb();
  });

  it('memory_search waits 15 seconds for the host before searching keyword-only itself', async () => {
    const start = Date.now();
    let settled = false;
    const call = createMemorySearch()
      .handler({ query: 'aardvarks' })
      .then((r) => {
        settled = true;
        return r;
      });
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    await wait(50);
    expect(getUndeliveredMessages().some((m) => JSON.parse(m.content).action === 'memory_search_request')).toBe(true);
    setSystemTime(new Date(start + 14_500));
    await wait(700);
    expect(settled).toBe(false);

    setSystemTime(new Date(start + 15_100));
    const result = await call;
    // Answered by the container's own keyword search over the read-only index.
    expect(json(result)).toMatchObject({ mode: 'keyword', results: [{ path: NOTE }] });
  });
});
