/**
 * MemoryFile, MemoryChunk and MemoryIndex lifecycle obligations propagated
 * from specs/memory.allium: FileDiscovered, FileUpdated, FileRemoved,
 * FileSynced, MemoryIndexCreated, IndexSettingsChanged, IndexBuilt, the
 * MemoryFile transition graph, the entity shapes and the two path/chunk
 * invariants.
 *
 * MemoryFile and MemoryChunk are realised by the group's own index.db (files,
 * chunks and their keyword and vector rows); MemoryIndex.built_with by its
 * recorded settings fingerprint. A file is `indexed` when its files row holds
 * the hash of its content on disk, `pending` otherwise (spec header: pending
 * is held by the host, re-derived by comparing content hashes). The real
 * MemoryIndexManager runs against a real index file in a temporary group
 * workspace; the process runs from the temporary root, as the host runs from
 * the repo, so stored paths are groups/<folder>/…. Only the embedding
 * provider, the rate limiter and the native watcher are faked.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import type { Ctl } from './fixtures.js';

const ctl = vi.hoisted(() => ({}) as Ctl);

vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../embeddings.js', async () => {
  const { fakeProvider: provider } = await import('./fixtures.js');
  return {
    DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
    createGeminiEmbeddingProvider: () => provider(ctl),
  };
});
vi.mock('../rate-limiter.js', async (importOriginal) => {
  const { fakeLimiter: limiter } = await import('./fixtures.js');
  return {
    ...(await importOriginal<typeof import('../rate-limiter.js')>()),
    sharedRateLimiter: (config: unknown) => {
      ctl.limiterConfigs.push(config);
      return limiter(ctl);
    },
  };
});
vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: async (dir: string, cb: never) => {
      ctl.watchers.set(dir, cb);
      return { unsubscribe: async () => {} };
    },
  },
}));

import { MemoryIndexManager } from '../manager.js';
import { registerMemoryWorkspaceDir, workspaceIndexDirs } from '../workspace-dirs.js';
import { changed, FINGERPRINT_KEY, readIndex, resetCtl, settled, sha256, tempRoot, writeFile } from './fixtures.js';
import { covered, obligation } from './harness.js';

// zotero-md/ is registered by the zotero module for the group it syncs into;
// registered here for every group, as that module would for this one.
registerMemoryWorkspaceDir({ subdir: 'zotero-md', source: 'zotero' });

const GROUP = 'ag-main';
const FOLDER = 'main';
let cwd: string;
let root: string;
let groupDir: string;
let dbPath: string;
const open: MemoryIndexManager[] = [];

beforeEach(() => {
  resetCtl(ctl);
  cwd = process.cwd();
  root = tempRoot('memory-spec-lifecycle-');
  process.chdir(root);
  groupDir = path.join(root, 'groups', FOLDER);
  fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
  dbPath = path.join(root, 'data', 'v2-memory', GROUP, 'index.db');
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((m) => m.close()));
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

const MEM = `groups/${FOLDER}/memory`;
const file = (rel: string) => path.join(root, rel);
const put = (rel: string, content: string) => writeFile(file(rel), content);

async function start(
  model = 'gemini-embedding-001',
  extra: Array<{ dir: string; source: string; pathPrefix?: string }> = [],
): Promise<MemoryIndexManager> {
  const m = new MemoryIndexManager(GROUP, FOLDER, path.join(groupDir, 'memory'), dbPath, 'test-key', model, [
    ...workspaceIndexDirs(groupDir),
    ...extra,
  ]);
  open.push(m);
  await m.init();
  await settled(m);
  return m;
}

async function stop(m: MemoryIndexManager): Promise<void> {
  open.splice(open.indexOf(m), 1);
  await m.close();
}

/** indexed: its row holds the hash of what is on disk; pending: anything else. */
function status(rel: string): 'indexed' | 'pending' {
  const row = readIndex(dbPath).files.find((f) => f.path === rel);
  return row && row.hash === sha256(fs.readFileSync(file(rel), 'utf-8')) ? 'indexed' : 'pending';
}

const chunksOf = (rel: string) => readIndex(dbPath).chunks.filter((c) => c.path === rel);
const embedded = () => ctl.batches.flat();

// ── MemoryFile transition graph ──────────────────────────────────────────────

obligation('transition-edge.MemoryFile.pending.indexed', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  put(`${MEM}/b.md`, '# B\n\nBadgers.\n');
  expect(status(`${MEM}/b.md`)).toBe('pending');
  expect(chunksOf(`${MEM}/b.md`)).toEqual([]);

  await changed(m);
  expect(status(`${MEM}/b.md`)).toBe('indexed');
  expect(chunksOf(`${MEM}/b.md`).map((c) => c.text)).toEqual(['# B\n\nBadgers.\n']);
});

obligation(
  'transition-edge.MemoryFile.indexed.pending',
  async () => {
    put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
    await start();
    expect(status(`${MEM}/a.md`)).toBe('indexed');

    // WorkspaceFileChanged: the watcher reports the edit; the file is pending
    // until the debounced sync it starts has re-indexed it.
    put(`${MEM}/a.md`, '# A\n\nAnteaters.\n');
    expect(status(`${MEM}/a.md`)).toBe('pending');
    ctl.watchers.get(path.join(groupDir, 'memory'))!(null, [{ path: file(`${MEM}/a.md`), type: 'update' }]);
    await vi.waitFor(() => expect(status(`${MEM}/a.md`)).toBe('indexed'), { timeout: 8_000, interval: 100 });
    expect(chunksOf(`${MEM}/a.md`).map((c) => c.text)).toEqual(['# A\n\nAnteaters.\n']);
  },
  15_000,
);

obligation('transition-rejected.MemoryFile.status', async () => {
  // No transition outside pending <-> indexed: an indexed file whose content
  // did not change is not re-indexed (indexed stays indexed, untouched) ...
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  const before = readIndex(dbPath);
  ctl.batches.length = 0;
  await changed(m);
  expect(embedded()).toEqual([]);
  expect(readIndex(dbPath).chunks).toEqual(before.chunks);

  // ... and a pending file whose embedding fails stays pending: it never
  // becomes indexed without its chunks.
  ctl.batchError = (texts) => (texts.some((t) => t.includes('Badgers')) ? new Error('provider down') : undefined);
  put(`${MEM}/b.md`, '# B\n\nBadgers.\n');
  await changed(m);
  expect(status(`${MEM}/b.md`)).toBe('pending');
  expect(readIndex(dbPath).files.map((f) => f.path)).toEqual([`${MEM}/a.md`]);
});

// ── Entities ─────────────────────────────────────────────────────────────────

obligation('entity-fields.MemoryFile', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  put(`groups/${FOLDER}/zettel/notes/old.md`, '---\nsuperseded_by: new.md\n---\nOld view.\n');
  await start();
  const ix = readIndex(dbPath);
  // group: the index is the group's own (data/v2-memory/<group>/index.db).
  expect(fs.existsSync(path.join(root, 'data', 'v2-memory', GROUP, 'index.db'))).toBe(true);
  expect(ix.files).toEqual([
    {
      path: `groups/${FOLDER}/memory/a.md`,
      source: 'memory',
      hash: sha256('# A\n\nAardvarks.\n'),
      superseded: 0,
    },
    {
      path: `groups/${FOLDER}/zettel/notes/old.md`,
      source: 'zettel',
      hash: sha256('---\nsuperseded_by: new.md\n---\nOld view.\n'),
      superseded: 1,
    },
  ]);
  // indexed_at: set by the sync that wrote the file's chunks.
  for (const c of ix.chunks) expect(c.updated_at).toBeGreaterThan(Date.now() - 60_000);
  // status: both indexed.
  expect(ix.files.map((f) => status(f.path))).toEqual(['indexed', 'indexed']);
});

obligation('entity-optional.MemoryFile.indexed_at', async () => {
  ctl.batchError = () => new Error('provider down');
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  // Null until first successful index: no row, no chunks, no timestamp.
  expect(readIndex(dbPath).files).toEqual([]);
  expect(chunksOf(`${MEM}/a.md`)).toEqual([]);

  ctl.batchError = null;
  const before = Date.now();
  await changed(m);
  const stamps = chunksOf(`${MEM}/a.md`).map((c) => c.updated_at);
  expect(stamps.length).toBeGreaterThan(0);
  for (const s of stamps) expect(s).toBeGreaterThanOrEqual(before);
});

obligation('entity-relationship.MemoryFile.chunks', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `Line ${i} about aardvarks and their burrows.`).join('\n');
  put(`${MEM}/a.md`, long);
  put(`${MEM}/b.md`, '# B\n\nBadgers.\n');
  await start();
  const a = chunksOf(`${MEM}/a.md`);
  const b = chunksOf(`${MEM}/b.md`);
  expect(a.length).toBeGreaterThan(1);
  expect(b).toHaveLength(1);
  // Each file's chunks are its own, and together they span its lines.
  const lines = long.split('\n');
  for (const c of a) expect(c.text).toBe(lines.slice(c.start_line - 1, c.end_line).join('\n'));
  expect(a[0]!.start_line).toBe(1);
  expect(a[a.length - 1]!.end_line).toBe(lines.length);
  expect(readIndex(dbPath).chunks).toHaveLength(a.length + b.length);
});

obligation('entity-fields.MemoryChunk', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const before = Date.now();
  await start();
  const [c] = chunksOf(`${MEM}/a.md`);
  expect(c).toMatchObject({
    path: `${MEM}/a.md`, // file
    start_line: 1,
    end_line: 4,
    text: '# A\n\nAardvarks.\n', // content
    hash: sha256('# A\n\nAardvarks.\n'), // SHA-256 of the chunk text
  });
  expect(c!.updated_at).toBeGreaterThanOrEqual(before); // indexed_at
  // The hash keys the embedding cache, per model.
  const ix = readIndex(dbPath);
  expect(ix.fts).toEqual([c!.id]);
});

obligation('entity-fields.MemoryIndex', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  // group: one index per group, at data/v2-memory/<group>/index.db.
  expect(path.relative(root, dbPath)).toBe(`data/v2-memory/${GROUP}/index.db`);
  // built_with: the settings fingerprint of its last full build.
  const builtWith = JSON.parse(readIndex(dbPath).meta[FINGERPRINT_KEY]!);
  expect(builtWith).toMatchObject({ model: 'gemini-embedding-001', provider: 'gemini', chunkTokens: 400 });
  expect(m.stats()?.settingsCurrent).toBe(true);
});

obligation('entity-optional.MemoryIndex.built_with', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  ctl.batchError = () => new Error('provider down');
  const first = await start();
  expect(readIndex(dbPath).meta[FINGERPRINT_KEY]).toBeUndefined();
  expect(first.stats()?.settingsCurrent).toBe(false);
  await stop(first);

  ctl.batchError = null;
  const second = await start();
  expect(readIndex(dbPath).meta[FINGERPRINT_KEY]).toEqual(expect.stringContaining('gemini-embedding-001'));
  expect(second.stats()?.settingsCurrent).toBe(true);
});

// ── FileUpdated ──────────────────────────────────────────────────────────────

covered(
  'rule-success.FileUpdated',
  'src/memory/memory.test.ts',
  'a changed file returns to pending and is re-indexed; its old chunks are replaced  [rule-success.FileUpdated] [transition-edge.MemoryFile.indexed.pending] [transition-edge.MemoryFile.pending.indexed]',
);

obligation('rule-failure.FileUpdated.4', async () => {
  // A change at a path with no record is not an update of any record: the
  // existing files keep their rows, and the new path gets one of its own.
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  const before = readIndex(dbPath);
  put(`${MEM}/b.md`, '# B\n\nBadgers.\n');
  await changed(m);
  const after = readIndex(dbPath);
  expect(after.files.find((f) => f.path === `${MEM}/a.md`)).toEqual(before.files[0]);
  expect(after.chunks.filter((c) => c.path === `${MEM}/a.md`)).toEqual(before.chunks);
  expect(after.files.map((f) => f.path)).toEqual([`${MEM}/a.md`, `${MEM}/b.md`]);
});

covered(
  'rule-failure.FileUpdated.5',
  'src/memory/memory.test.ts',
  'an event without a content change re-indexes nothing  [rule-failure.FileUpdated.2]',
);

// ── FileDiscovered ───────────────────────────────────────────────────────────

covered(
  'rule-success.FileDiscovered',
  'src/memory/memory.test.ts',
  'a new file is discovered and indexed: a files row, and chunks with their keyword and vector rows  [rule-success.FileDiscovered] [rule-success.FileSynced]',
);

obligation('rule-failure.FileDiscovered.4', async () => {
  // A path already in the index is not discovered again: one row, not two,
  // and its chunks are not rewritten.
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  const before = readIndex(dbPath);
  ctl.batches.length = 0;
  await changed(m);
  await changed(m);
  expect(readIndex(dbPath).files).toEqual(before.files);
  expect(readIndex(dbPath).chunks).toEqual(before.chunks);
  expect(embedded()).toEqual([]);
});

obligation('rule-entity-creation.FileDiscovered.1', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  await start();
  // Created with its group's index, path, content hash and superseded = false;
  // pending until its sync, which wrote the row (status: indexed now).
  expect(readIndex(dbPath).files).toEqual([
    { path: `${MEM}/a.md`, source: 'memory', hash: sha256('# A\n\nAardvarks.\n'), superseded: 0 },
  ]);
});

// ── FileRemoved ──────────────────────────────────────────────────────────────

covered(
  'rule-success.FileRemoved',
  'src/memory/memory.test.ts',
  'a removed file leaves the index: its record, chunks, keyword and vector rows  [rule-success.FileRemoved]',
);

obligation('rule-failure.FileRemoved.4', async () => {
  // Removing a path the index never held removes nothing.
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  put(`${MEM}/notes.txt`, 'not an indexed format');
  const m = await start();
  const before = readIndex(dbPath);
  fs.rmSync(file(`${MEM}/notes.txt`));
  await changed(m);
  const after = readIndex(dbPath);
  expect(after.files).toEqual(before.files);
  expect(after.chunks).toEqual(before.chunks);
  expect(after.fts).toEqual(before.fts);
});

// ── FileSynced ───────────────────────────────────────────────────────────────

obligation('rule-success.FileSynced', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  const old = chunksOf(`${MEM}/a.md`);

  const content = '---\nsuperseded_by: b.md\n---\n# A\n\nAnteaters.\n';
  put(`${MEM}/a.md`, content);
  const before = Date.now();
  await changed(m);
  const row = readIndex(dbPath).files.find((f) => f.path === `${MEM}/a.md`)!;
  expect(row).toMatchObject({ hash: sha256(content), superseded: 1 }); // superseded = names_superseded_by
  const now = chunksOf(`${MEM}/a.md`);
  // Old chunks gone, the new set created, stamped now, with keyword and vector rows.
  expect(now.map((c) => c.text)).toEqual([content]);
  expect(now.map((c) => c.id)).not.toEqual(old.map((c) => c.id));
  for (const c of now) expect(c.updated_at).toBeGreaterThanOrEqual(before);
  const ix = readIndex(dbPath);
  expect(ix.fts).toEqual(now.map((c) => c.id));
  if (ix.vec.length > 0) expect(ix.vec).toEqual(now.map((c) => c.id));
});

obligation('rule-failure.FileSynced.4', async () => {
  // A file that is not pending (indexed, unchanged) is not chunked or embedded.
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  const before = chunksOf(`${MEM}/a.md`);
  ctl.batches.length = 0;
  await changed(m);
  expect(embedded()).toEqual([]);
  expect(chunksOf(`${MEM}/a.md`)).toEqual(before);
});

// ── MemoryIndexCreated / IndexSettingsChanged / IndexBuilt ───────────────────

obligation('rule-success.MemoryIndexCreated', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  expect(fs.existsSync(dbPath)).toBe(false);
  const m = await start();
  expect(fs.existsSync(dbPath)).toBe(true);
  // Opened with no recorded settings: its first full pass says so.
  expect(m.stats()?.lastFullReindex).toMatchObject({
    reason: 'first full build (no settings recorded)',
    result: 'completed',
  });
});

obligation('rule-entity-creation.MemoryIndexCreated.1', async () => {
  // Created for its group with built_with = null: shown before any full pass
  // can finish (the provider refuses every batch).
  ctl.batchError = () => new Error('provider down');
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  await start();
  expect(path.relative(root, dbPath)).toBe(`data/v2-memory/${GROUP}/index.db`);
  expect(readIndex(dbPath).meta[FINGERPRINT_KEY]).toBeUndefined();
});

obligation('rule-failure.MemoryIndexCreated.4', async () => {
  // An index that exists is not created afresh: its recorded settings and
  // entries survive the next open, and no first build runs.
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  await stop(await start());
  const before = readIndex(dbPath);
  ctl.batches.length = 0;
  const m = await start();
  expect(readIndex(dbPath).meta[FINGERPRINT_KEY]).toBe(before.meta[FINGERPRINT_KEY]);
  expect(readIndex(dbPath).chunks).toEqual(before.chunks);
  expect(embedded()).toEqual([]);
  expect(m.stats()?.reindex).toBeNull();
});

covered(
  'rule-success.IndexSettingsChanged',
  'src/memory/startup-fingerprint.test.ts',
  'a restart under another embedding model re-indexes every file',
);

obligation('rule-failure.IndexSettingsChanged.4', async () => {
  // No index yet: its first pass is a first build, not a settings change.
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start('gemini-embedding-002');
  const reason = m.stats()?.lastFullReindex?.reason;
  expect(reason).toBe('first full build (no settings recorded)');
  expect(reason).not.toMatch(/→/);
});

covered(
  'rule-failure.IndexSettingsChanged.5',
  'src/memory/startup-fingerprint.test.ts',
  'a restart with unchanged settings leaves unchanged files untouched',
);

obligation('rule-success.IndexBuilt', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  put(`${MEM}/b.md`, '# B\n\nBadgers.\n');
  await stop(await start());
  const m = await start('gemini-embedding-002');
  // The full pass reached every file: the index records the settings it ran under.
  expect(JSON.parse(readIndex(dbPath).meta[FINGERPRINT_KEY]!)).toMatchObject({ model: 'gemini-embedding-002' });
  expect(m.stats()?.settingsCurrent).toBe(true);
  expect(m.stats()?.lastFullReindex).toMatchObject({ result: 'completed', files: 2 });
});

obligation('rule-failure.IndexBuilt.1', async () => {
  // A pass that does not complete on the open index — here the index is
  // closed under it — records nothing.
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  let release!: () => void;
  ctl.gate = new Promise<void>((r) => (release = r));
  const m = new MemoryIndexManager(
    GROUP,
    FOLDER,
    path.join(groupDir, 'memory'),
    dbPath,
    'test-key',
    'gemini-embedding-001',
  );
  await m.init();
  await vi.waitFor(() => expect(ctl.batches.length).toBe(1));
  const closing = m.close();
  release();
  await closing;
  expect(readIndex(dbPath).meta[FINGERPRINT_KEY]).toBeUndefined();
});

// ── Invariants ───────────────────────────────────────────────────────────────

obligation('invariant.MemoryFilesWithinWorkspace', async () => {
  put(`groups/${FOLDER}/memory/a.md`, '# A\n\nAardvarks.\n');
  put(`groups/${FOLDER}/zettel/notes/n.md`, '# N\n\nA note.\n');
  put(`groups/${FOLDER}/zotero-md/item.md`, '# Item\n\nA paper.\n');
  // Not indexed: the rest of the workspace.
  put(`groups/${FOLDER}/CLAUDE.md`, '# Instructions\n');
  put(`groups/${FOLDER}/conversations/2026-10-28.md`, '# Transcript\n');
  put(`groups/${FOLDER}/memory/node_modules/x.md`, '# Vendored\n');
  // An indexed mount, stored under the path the container sees.
  const org = path.join(root, 'elsewhere', 'org');
  writeFile(path.join(org, 'gtd.org'), '* TODO Dig\n');

  const m = await start('gemini-embedding-001', [{ dir: org, source: 'org', pathPrefix: 'extra/org' }]);
  put(`groups/${FOLDER}/memory/b.md`, '# B\n\nBadgers.\n');
  await changed(m);

  const paths = readIndex(dbPath).files.map((f) => f.path);
  expect(paths).toEqual([
    'extra/org/gtd.org',
    `groups/${FOLDER}/memory/a.md`,
    `groups/${FOLDER}/memory/b.md`,
    `groups/${FOLDER}/zettel/notes/n.md`,
    `groups/${FOLDER}/zotero-md/item.md`,
  ]);
  for (const p of paths) {
    const inWorkspace =
      p.startsWith('groups/') && (p.includes('/memory/') || p.includes('/zettel/') || p.includes('/zotero-md/'));
    expect(inWorkspace || p.startsWith('extra/'), p).toBe(true);
  }
});

obligation('invariant.ChunksPresentOnlyWhenIndexed', async () => {
  // A file that never completed a sync has no chunks — even when some of its
  // batches were embedded before one failed.
  const long = Array.from({ length: 4000 }, (_, i) => `Line ${i} about aardvarks.`).join('\n');
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  put(`${MEM}/big.md`, long);
  let calls = 0;
  ctl.batchError = (texts) =>
    texts.some((t) => t.includes('Line ')) && ++calls > 1 ? new Error('provider down') : undefined;
  const m = await start();
  expect(calls).toBeGreaterThan(1);
  expect(chunksOf(`${MEM}/big.md`)).toEqual([]);
  expect(readIndex(dbPath).files.map((f) => f.path)).toEqual([`${MEM}/a.md`]);

  // Re-indexing an indexed file keeps its old chunks until the new set
  // replaces them whole (the window the invariant permits).
  ctl.batchError = () => new Error('provider down');
  const before = chunksOf(`${MEM}/a.md`);
  put(`${MEM}/a.md`, '# A\n\nAnteaters.\n');
  await changed(m);
  expect(chunksOf(`${MEM}/a.md`)).toEqual(before);
  // Every chunk belongs to a file the index holds.
  const files = new Set(readIndex(dbPath).files.map((f) => f.path));
  expect(readIndex(dbPath).chunks.every((c) => files.has(c.path))).toBe(true);
});
