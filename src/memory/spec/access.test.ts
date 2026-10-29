/**
 * Reading memory, propagated from specs/memory.allium: MemorySearched,
 * MemoryFileRead, MemoryListed and the MemoryMcpTools surface — who may
 * search, get and list which group's index (memory_group_for(session)).
 *
 * Search is answered on the host: the container's memory_search_request goes
 * through the real registered delivery action to the real host search over a
 * real index. Get and list run in the container over the group's index,
 * mounted read-only at /workspace/memory: their gate is the mount and the
 * NANOCLAW_MEMORY_ENABLED env the host's session contributors hand a session
 * (withSessionContributions, with every registered contributor), and their
 * reads are covered by bun tests under container/agent-runner. The install is
 * world.ts: real central DB, real specialists module (memory-provider access),
 * real memory module, temporary GROUPS_DIR / DATA_DIR, no real .env.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';

import type { Ctl } from './fixtures.js';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return { root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-spec-access-'))) };
});
const ctl = vi.hoisted(() => ({}) as Ctl);
const written = vi.hoisted(() => [] as Array<{ groupId: string; sessionId: string; message: { content: string } }>);

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
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  writeSessionMessage: async (groupId: string, sessionId: string, message: { content: string }) => {
    written.push({ groupId, sessionId, message });
  },
}));

import { closeDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAction } from '../../delivery.js';
import '../../modules/specialists/index.js';
import { closeAllMemoryManagers } from '../manager.js';
import { handleMemorySearch } from '../search.js';
import { resetCtl } from './fixtures.js';
import { covered, obligation } from './harness.js';
import {
  buildWorld,
  clearSettings,
  contribution,
  GROUPS,
  indexDir,
  repoPath,
  resetFiles,
  SESSIONS,
  startMemory,
} from './world.js';

const KEY = 'test-key';
let cwd: string;

beforeAll(async () => {
  cwd = process.cwd();
  process.chdir(env.root);
  resetCtl(ctl);
  await buildWorld();
});
beforeEach(async () => {
  resetCtl(ctl);
  clearSettings();
  written.length = 0;
  await resetFiles();
});
afterAll(async () => {
  await closeAllMemoryManagers();
  clearSettings();
  await closeDb();
  process.chdir(cwd);
  fs.rmSync(env.root, { recursive: true, force: true });
});

type Answer = { type: string; requestId: string; mode?: string; results?: Array<{ path: string }>; error?: string };

/** The container's memory_search, as the host's delivery loop runs it; the answer written back. */
async function askHost(from: keyof typeof SESSIONS, content: Record<string, unknown> = {}): Promise<Answer> {
  const session = await getSession(SESSIONS[from].id);
  written.length = 0;
  await getDeliveryAction('memory_search_request')!({ requestId: 'r1', query: 'aardvarks', ...content }, session!);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ groupId: SESSIONS[from].agent_group_id, sessionId: SESSIONS[from].id });
  return JSON.parse(written[0]!.message.content) as Answer;
}

const paths = (a: Answer) => (a.results ?? []).map((r) => r.path);

// ── MemorySearched ───────────────────────────────────────────────────────────

obligation('rule-success.MemorySearched', async () => {
  await startMemory({ key: KEY });
  const answer = await askHost('main');
  expect(answer).toMatchObject({ type: 'memory_search_response', requestId: 'r1', mode: 'hybrid' });
  expect(paths(answer)).toEqual([repoPath('main')]);
});

obligation('rule-failure.MemorySearched.1', async () => {
  await startMemory({ key: KEY, groups: 'main,side' });
  // A session searches only memory_group_for(session): side may not name main's index ...
  await expect(
    handleMemorySearch({ session: SESSIONS.side, group_id: GROUPS.main.id, query: 'aardvarks' }),
  ).rejects.toThrow(/may not search/);
  // ... nor the memory provider its own group's; it reads the group its chain serves.
  await expect(
    handleMemorySearch({ session: SESSIONS.mem, group_id: GROUPS.mem.id, query: 'aardvarks' }),
  ).rejects.toThrow(/may not search/);
  expect(paths(await askHost('mem'))).toEqual([repoPath('main')]);
  expect(paths(await askHost('side'))).toEqual([repoPath('side')]);
});

obligation('rule-failure.MemorySearched.2', async () => {
  await startMemory({ key: KEY, groups: 'main,side,coder,memprov' });
  // A (non-provider) specialist session: no group to search, though main's index exists.
  expect(await askHost('coder')).toMatchObject({ mode: 'unavailable', results: [] });
  await expect(
    handleMemorySearch({ session: SESSIONS.coder, group_id: GROUPS.coder.id, query: 'aardvarks' }),
  ).rejects.toThrow(/may not search/);
});

obligation('rule-failure.MemorySearched.3', async () => {
  await startMemory({ key: KEY });
  // side's own file mentions aardvarks; side is not allowlisted.
  expect(await askHost('side')).toMatchObject({ mode: 'unavailable', results: [] });
});

obligation('rule-failure.MemorySearched.4', async () => {
  await startMemory({ groups: 'main,side' });
  expect(await askHost('main')).toMatchObject({ mode: 'unavailable', results: [] });
});

// ── MemoryFileRead ───────────────────────────────────────────────────────────

covered(
  'rule-success.MemoryFileRead',
  'container/agent-runner/src/mcp-tools/memory-index-reads.test.ts',
  'memory_get_file_content returns an indexed file read from the workspace, with its frontmatter by default',
);

obligation('rule-failure.MemoryFileRead.1', async () => {
  await startMemory({ key: KEY, groups: 'main,side' });
  // The memory provider reads main's index, through its mount of main's folder;
  // side reads its own, never main's.
  const mem = await contribution('mem');
  expect(mem.memoryMount).toEqual({ hostPath: indexDir('main'), containerPath: '/workspace/memory', readonly: true });
  expect(mem.env.NANOCLAW_MEMORY_WORKSPACE).toBe('/workspace/extra/main');
  const side = await contribution('side');
  expect(side.memoryMount?.hostPath).toBe(indexDir('side'));
  expect(side.env.NANOCLAW_MEMORY_WORKSPACE).toBe('/workspace/agent');
});

obligation('rule-failure.MemoryFileRead.2', async () => {
  await startMemory({ key: KEY, groups: 'main,side,coder,memprov' });
  const coder = await contribution('coder');
  expect(coder.memoryMount).toBeUndefined();
  expect(coder.env).not.toHaveProperty('NANOCLAW_MEMORY_ENABLED');
});

obligation('rule-failure.MemoryFileRead.3', async () => {
  await startMemory({ key: KEY });
  const side = await contribution('side');
  expect(side.memoryMount).toBeUndefined();
  expect(side.env).not.toHaveProperty('NANOCLAW_MEMORY_ENABLED');
});

obligation('rule-failure.MemoryFileRead.4', async () => {
  await startMemory({ groups: 'main' });
  const main = await contribution('main');
  expect(main.memoryMount).toBeUndefined();
  expect(main.env).not.toHaveProperty('NANOCLAW_MEMORY_ENABLED');
});

covered(
  'rule-failure.MemoryFileRead.5',
  'container/agent-runner/src/mcp-tools/memory-index-reads.test.ts',
  'memory_get_file_content refuses a path the index does not hold, even when the file is on disk',
);

// ── MemoryListed ─────────────────────────────────────────────────────────────

covered(
  'rule-success.MemoryListed',
  'container/agent-runner/src/mcp-tools/memory-index-reads.test.ts',
  'memory_list_files lists every indexed file, newest first, when given no params',
);

obligation('rule-failure.MemoryListed.1', async () => {
  await startMemory({ key: KEY, groups: 'main,side' });
  // main lists its own index, read-only; side's index exists but is not main's to list.
  const main = await contribution('main');
  expect(main.memoryMount).toEqual({ hostPath: indexDir('main'), containerPath: '/workspace/memory', readonly: true });
  expect(fs.existsSync(indexDir('side'))).toBe(true);
});

obligation('rule-failure.MemoryListed.2', async () => {
  await startMemory({ key: KEY, groups: 'main,side,coder,memprov' });
  // The memory provider's own (specialist) group is never what it lists.
  const mem = await contribution('mem');
  expect(mem.memoryMount?.hostPath).not.toBe(indexDir('mem'));
  expect(mem.memoryMount?.hostPath).toBe(indexDir('main'));
  expect(fs.existsSync(indexDir('mem'))).toBe(false);
});

obligation('rule-failure.MemoryListed.3', async () => {
  // side was indexed once, then left the allowlist: its old index stays on
  // disk, frozen, and is no longer handed to its sessions.
  await startMemory({ key: KEY, groups: 'main,side' });
  expect((await contribution('side')).memoryMount).toBeDefined();
  await startMemory({ key: KEY });
  expect(fs.existsSync(path.join(indexDir('side'), 'index.db'))).toBe(true);
  expect((await contribution('side')).memoryMount).toBeUndefined();
});

obligation('rule-failure.MemoryListed.4', async () => {
  // The key removed: main's index stays on disk and is no longer handed out.
  await startMemory({ key: KEY });
  expect((await contribution('main')).memoryMount).toBeDefined();
  await startMemory({});
  expect(fs.existsSync(path.join(indexDir('main'), 'index.db'))).toBe(true);
  const main = await contribution('main');
  expect(main.memoryMount).toBeUndefined();
  expect(main.env).not.toHaveProperty('NANOCLAW_MEMORY_ENABLED');
});

// ── MemoryMcpTools ───────────────────────────────────────────────────────────

obligation('surface-actor.MemoryMcpTools', async () => {
  await startMemory({ key: KEY, groups: 'main,side' });
  // The group is filled in by the host from the session, never chosen by the
  // agent: a request naming another group is answered from the caller's own.
  const answer = await askHost('main', { group_id: GROUPS.side.id, group: GROUPS.side.id, agent_group_id: 'ag-side' });
  expect(paths(answer)).toEqual([repoPath('main')]);
});

obligation('surface-provides.MemoryMcpTools', async () => {
  await startMemory({ key: KEY });
  // Offered exactly when memory_group_for(session) names an indexed group.
  const offered = async (k: keyof typeof SESSIONS) => (await contribution(k)).env.NANOCLAW_MEMORY_ENABLED === '1';
  expect(await offered('main')).toBe(true); // own group, allowlisted
  expect(await offered('mem')).toBe(true); // memory provider, over main's index
  expect(await offered('side')).toBe(false); // own group not allowlisted
  expect(await offered('coder')).toBe(false); // other specialists dispatch a memory provider instead
});
