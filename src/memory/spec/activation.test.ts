/**
 * When memory runs at all, propagated from specs/memory.allium: the three
 * requires every indexing rule shares — group.specialist = null, the folder in
 * config.memory_search_groups, config.embedding_key_configured — for
 * FileDiscovered, FileUpdated, FileRemoved, FileSynced, MemoryIndexCreated and
 * IndexSettingsChanged; the two invariants they uphold; and the two config
 * defaults that are the switch (an embedding key) and the allowlist ("main").
 *
 * The memory module's real host start runs against a real central DB with
 * the real specialists module loaded (its exclusion is what makes a group a
 * specialist here), over temporary GROUPS_DIR / DATA_DIR — see world.ts.
 * Settings come from process.env; the real .env is never read.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';

import type { Ctl } from './fixtures.js';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return { root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-spec-activation-'))) };
});
const ctl = vi.hoisted(() => ({}) as Ctl);

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `${env.root}/data`,
  GROUPS_DIR: `${env.root}/groups`,
}));
vi.mock('../../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../env.js')>()),
  readEnvFile: () => ({}),
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../embeddings.js', async () => {
  const { fakeProvider } = await import('./fixtures.js');
  return {
    DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
    createGeminiEmbeddingProvider: () => fakeProvider(ctl),
  };
});
vi.mock('../rate-limiter.js', async (importOriginal) => {
  const { fakeLimiter } = await import('./fixtures.js');
  return {
    ...(await importOriginal<typeof import('../rate-limiter.js')>()),
    sharedRateLimiter: () => fakeLimiter(ctl),
  };
});
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));
vi.mock('../../modules/specialists/invocation.js', () => ({
  buildInvocationForSession: vi.fn().mockResolvedValue(null),
  endInvocationById: vi.fn(),
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
  hostStagingPath: vi.fn(),
  reclaimTransferStaging: vi.fn(),
  sweepInvocationDirs: vi.fn(),
  sweepTransferStaging: vi.fn(),
}));

import { closeDb } from '../../db/connection.js';
import '../../modules/specialists/index.js';
import { closeAllMemoryManagers, getMemoryManager, MemoryIndexManager } from '../manager.js';
import { resetCtl, settled, sha256 } from './fixtures.js';
import { divergence, obligation } from './harness.js';
import {
  buildWorld,
  clearSettings,
  diskPath,
  FILES,
  GROUPS,
  type GroupKey,
  indexDir,
  indexFile,
  indexRows,
  repoPath,
  resetFiles,
  startMemory,
} from './world.js';

const KEY = 'test-key';
const ALL = 'main,side,coder,memprov';
let cwd: string;

beforeAll(async () => {
  cwd = process.cwd();
  // The host runs from the repo: indexed paths are groups/<folder>/….
  process.chdir(env.root);
  resetCtl(ctl);
  await buildWorld();
});
beforeEach(async () => {
  resetCtl(ctl);
  clearSettings();
  await resetFiles();
});
afterAll(async () => {
  await closeAllMemoryManagers();
  clearSettings();
  await closeDb();
  process.chdir(cwd);
  fs.rmSync(env.root, { recursive: true, force: true });
});

const embeddedText = () => ctl.batches.flat().join('\n');
const managed = () =>
  (Object.keys(GROUPS) as GroupKey[]).filter((k) => getMemoryManager(GROUPS[k].id) !== undefined).sort();

/**
 * An index left in a group's data dir from before — as a group that was once
 * indexed keeps it — built directly, outside the host's gating.
 */
async function leftoverIndex(k: GroupKey, model = 'gemini-embedding-001'): Promise<void> {
  const m = new MemoryIndexManager(GROUPS[k].id, GROUPS[k].folder, path.dirname(diskPath(k)), indexFile(k), KEY, model);
  await m.init();
  await settled(m);
  await m.close();
}

const rowFor = (k: GroupKey) => indexRows(k)?.files.find((f) => f.path === repoPath(k));

// ── The switch and the allowlist ─────────────────────────────────────────────

// The spec declares embedding_key_configured = true by default. In the code
// the switch is MEMORY_SEARCH_GEMINI_API_KEY, which nothing sets by default:
// an install with no settings runs no memory at all. (That a key alone turns
// memory on, with no other flag, is shown by config-default.memory_search_groups
// below; that no key means no memory, by the rule-failure.*.3 tests.)
divergence(
  'config-default.embedding_key_configured',
  'no embedding key is configured by default (MEMORY_SEARCH_GEMINI_API_KEY unset), so with no settings memory is off for every group',
  async () => {
    await startMemory({});
    expect(managed()).toEqual(['main']);
  },
);

obligation('config-default.memory_search_groups', async () => {
  // Default { "main" }: only the group whose folder is main. A key is the
  // only other setting it takes.
  await startMemory({ key: KEY });
  expect(managed()).toEqual(['main']);
  expect(fs.existsSync(indexDir('side'))).toBe(false);

  // Comma-separated in the environment.
  await startMemory({ key: KEY, groups: ' main , side ' });
  expect(managed()).toEqual(['main', 'side']);
  expect(rowFor('side')?.hash).toBe(sha256(FILES.side.content));
});

// ── FileDiscovered ───────────────────────────────────────────────────────────

obligation('rule-failure.FileDiscovered.1', async () => {
  fs.writeFileSync(diskPath('coder', 'memory/new.md'), '# New\n\nA new specialist file.\n');
  await startMemory({ key: KEY, groups: ALL });
  expect(fs.existsSync(indexDir('coder'))).toBe(false);
  expect(embeddedText()).not.toContain('specialist');
});

obligation('rule-failure.FileDiscovered.2', async () => {
  await startMemory({ key: KEY });
  fs.writeFileSync(diskPath('side', 'memory/new.md'), '# New\n\nA new side file.\n');
  await getMemoryManager(GROUPS.main.id)!.sync();
  expect(indexRows('side')).toBeNull();
  expect(indexRows('main')!.files.map((f) => f.path)).toEqual([repoPath('main')]);
});

obligation('rule-failure.FileDiscovered.3', async () => {
  await startMemory({ groups: ALL });
  for (const k of Object.keys(GROUPS) as GroupKey[]) expect(indexRows(k)).toBeNull();
  expect(ctl.batches).toEqual([]);
});

// ── FileUpdated ──────────────────────────────────────────────────────────────

obligation('rule-failure.FileUpdated.1', async () => {
  await leftoverIndex('coder');
  const before = rowFor('coder')!;
  fs.writeFileSync(diskPath('coder'), '# Coder\n\nChanged scratch.\n');
  await startMemory({ key: KEY, groups: ALL });
  expect(getMemoryManager(GROUPS.coder.id)).toBeUndefined();
  expect(rowFor('coder')).toEqual(before);
});

obligation('rule-failure.FileUpdated.2', async () => {
  await startMemory({ key: KEY, groups: 'main,side' });
  const before = rowFor('side')!;
  fs.writeFileSync(diskPath('side'), '# Side\n\nChanged.\n');
  await startMemory({ key: KEY });
  expect(rowFor('side')).toEqual(before);
  expect(before.hash).toBe(sha256(FILES.side.content));
});

obligation('rule-failure.FileUpdated.3', async () => {
  await startMemory({ key: KEY });
  const before = rowFor('main')!;
  fs.writeFileSync(diskPath('main'), '# Main\n\nChanged.\n');
  await startMemory({});
  expect(managed()).toEqual([]);
  expect(rowFor('main')).toEqual(before);
});

// ── FileRemoved ──────────────────────────────────────────────────────────────

obligation('rule-failure.FileRemoved.1', async () => {
  await leftoverIndex('coder');
  fs.rmSync(diskPath('coder'));
  await startMemory({ key: KEY, groups: ALL });
  expect(rowFor('coder')?.hash).toBe(sha256(FILES.coder.content));
  expect(indexRows('coder')!.chunks).toBeGreaterThan(0);
});

obligation('rule-failure.FileRemoved.2', async () => {
  await startMemory({ key: KEY, groups: 'main,side' });
  fs.rmSync(diskPath('side'));
  await startMemory({ key: KEY });
  expect(rowFor('side')?.hash).toBe(sha256(FILES.side.content));
});

obligation('rule-failure.FileRemoved.3', async () => {
  await startMemory({ key: KEY });
  fs.rmSync(diskPath('main'));
  await startMemory({});
  expect(rowFor('main')?.hash).toBe(sha256(FILES.main.content));
  expect(indexRows('main')!.chunks).toBeGreaterThan(0);
});

// ── FileSynced ───────────────────────────────────────────────────────────────

obligation('rule-failure.FileSynced.1', async () => {
  await startMemory({ key: KEY, groups: ALL });
  // Nothing of either specialist's folder is chunked or embedded.
  expect(embeddedText()).toContain('Aardvarks live in main');
  expect(embeddedText()).not.toContain('specialist scratch');
  expect(embeddedText()).not.toContain('provider scratch');
});

obligation('rule-failure.FileSynced.2', async () => {
  await startMemory({ key: KEY });
  expect(embeddedText()).toContain('Aardvarks live in main');
  expect(embeddedText()).not.toContain('live in side');
});

obligation('rule-failure.FileSynced.3', async () => {
  await startMemory({ key: KEY });
  fs.writeFileSync(diskPath('main'), '# Main\n\nPending change.\n');
  ctl.batches.length = 0;
  await startMemory({});
  expect(ctl.batches).toEqual([]);
  expect(indexRows('main')!.chunks).toBeGreaterThan(0);
});

// ── MemoryIndexCreated ───────────────────────────────────────────────────────

obligation('rule-failure.MemoryIndexCreated.1', async () => {
  await startMemory({ key: KEY, groups: ALL });
  expect(fs.existsSync(indexDir('coder'))).toBe(false);
  expect(fs.existsSync(indexDir('mem'))).toBe(false);
  expect(fs.existsSync(indexFile('main'))).toBe(true);
});

obligation('rule-failure.MemoryIndexCreated.2', async () => {
  await startMemory({ key: KEY });
  expect(fs.existsSync(indexDir('side'))).toBe(false);
  expect(fs.existsSync(indexFile('main'))).toBe(true);
});

obligation('rule-failure.MemoryIndexCreated.3', async () => {
  await startMemory({ groups: ALL });
  expect(fs.existsSync(path.join(env.root, 'data', 'v2-memory'))).toBe(false);
});

// ── IndexSettingsChanged ─────────────────────────────────────────────────────

obligation('rule-failure.IndexSettingsChanged.1', async () => {
  await leftoverIndex('coder', 'gemini-embedding-001');
  const before = indexRows('coder')!;
  await startMemory({ key: KEY, groups: ALL, model: 'gemini-embedding-002' });
  expect(indexRows('coder')).toEqual(before);
  expect(before.fingerprint).toContain('gemini-embedding-001');
});

obligation('rule-failure.IndexSettingsChanged.2', async () => {
  await startMemory({ key: KEY, groups: 'main,side' });
  const before = indexRows('side')!;
  await startMemory({ key: KEY, model: 'gemini-embedding-002' });
  expect(indexRows('main')!.fingerprint).toContain('gemini-embedding-002');
  expect(indexRows('side')).toEqual(before);
  expect(before.fingerprint).toContain('gemini-embedding-001');
});

obligation('rule-failure.IndexSettingsChanged.3', async () => {
  await startMemory({ key: KEY });
  const before = indexRows('main')!;
  ctl.batches.length = 0;
  await startMemory({ model: 'gemini-embedding-002' });
  expect(indexRows('main')).toEqual(before);
  expect(ctl.batches).toEqual([]);
});

// ── Invariants ───────────────────────────────────────────────────────────────

obligation('invariant.NoMemoryFilesForSpecialistGroups', async () => {
  // Every folder allowlisted: the two specialist groups still get no index —
  // not even the memory provider, which reads main's.
  await startMemory({ key: KEY, groups: ALL });
  expect(managed()).toEqual(['main', 'side']);
  const indexed = fs.readdirSync(path.join(env.root, 'data', 'v2-memory')).sort();
  expect(indexed).toEqual([GROUPS.main.id, GROUPS.side.id]);
  for (const k of ['main', 'side'] as const) {
    for (const f of indexRows(k)!.files) expect(f.path.startsWith(`groups/${GROUPS[k].folder}/`)).toBe(true);
  }
});

obligation('invariant.NoMemoryFilesForNonAllowlistedGroups', async () => {
  await startMemory({ key: KEY, groups: 'side' });
  expect(managed()).toEqual(['side']);
  expect(fs.readdirSync(path.join(env.root, 'data', 'v2-memory'))).toEqual([GROUPS.side.id]);
  expect(indexRows('side')!.files.map((f) => f.path)).toEqual([repoPath('side')]);
  // A search syncs first; the allowlist still holds after it.
  await getMemoryManager(GROUPS.side.id)!.search('aardvarks');
  await settled(getMemoryManager(GROUPS.side.id)!);
  expect(indexRows('main')).toBeNull();
});
