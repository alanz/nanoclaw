/**
 * Propagated from specs/memory-graph.allium — what a researcher's container
 * is given (ResearcherKnowledgeIsolation), and why no specialist can write a
 * note (NotesCreatedByMainAgentOnly, and the specialist = null requires of
 * SupersedingNoteWritten and SynthesisCandidatesScanned).
 *
 * The real session contributors of the specialists, memory and zotero
 * modules, composed by the real withSessionContributions, against a migrated
 * test DB and a temporary GROUPS_DIR / DATA_DIR. The host is made to run a
 * memory index for every group and to sync Zotero into the main group, so
 * the only thing keeping either from a researcher is the decision under test.
 * The ipc-in / ipc-out mounts (the file handover) are covered by the
 * specialists suite and are left out here.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ root: '/tmp/nanoclaw-test-graph-spec-isolation' }));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `${h.root}/data`,
  GROUPS_DIR: `${h.root}/groups`,
}));
vi.mock('../../modules/zotero/config.js', () => ({ ZOTERO_GROUP_FOLDER: 'main', ZOTERO_POLL_INTERVAL: 3_600_000 }));
vi.mock('../../modules/zotero/monitor.js', () => ({ startZoteroMonitor: vi.fn() }));
vi.mock('../../modules/specialists/invocation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/specialists/invocation.js')>()),
  buildInvocationForSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('../manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../manager.js')>()),
  // A manager runs for every group: the memory gate is then access alone.
  getMemoryManager: vi.fn(() => ({})),
}));

import { withSessionContributions, type SessionContribution } from '../../container-runner.js';
import { createAgentGroup, getAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createSpecialist, createTask } from '../../modules/specialists/db.js';
import type { SpecialistTask } from '../../modules/specialists/types.js';
import { memoryAccessFor } from '../manager.js';
import '../../modules/specialists/index.js';
import '../../modules/memory/index.js';
import '../../modules/zotero/index.js';
import { obligation } from './harness.js';

const GROUPS = `${h.root}/groups`;
const DATA = `${h.root}/data`;
const now = () => new Date().toISOString();

async function group(id: string, folder: string, kind: 'plain' | 'specialist' | 'memory'): Promise<void> {
  await createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: now() });
  fs.mkdirSync(path.join(GROUPS, folder), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'v2-memory', id), { recursive: true }); // an index dir for every group
  if (kind === 'plain') return;
  await createSpecialist({
    agent_group_id: id,
    is_memory_provider: kind === 'memory' ? 1 : 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
}

async function session(id: string, agentGroupId: string, threadId: string | null): Promise<void> {
  await createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });
}

function taskRow(over: Partial<SpecialistTask> & Pick<SpecialistTask, 'id' | 'specialist_group_id'>): SpecialistTask {
  return {
    prompt: 'p',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
    ...over,
  };
}

async function contributionFor(sessionId: string): Promise<SessionContribution> {
  const session = (await getSession(sessionId))!;
  const agentGroup = (await getAgentGroup(session.agent_group_id))!;
  return withSessionContributions({}, { agentGroup, session });
}

/** Host paths of a contribution's mounts that reach a group folder or a memory index. */
function groupOrMemoryMounts(c: SessionContribution): Array<{ hostPath: string; readonly?: boolean }> {
  return (c.mounts ?? []).filter(
    (m) => m.hostPath.startsWith(GROUPS + '/') || m.hostPath.startsWith(path.join(DATA, 'v2-memory') + '/'),
  );
}

beforeAll(async () => {
  fs.rmSync(h.root, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  // Every fixture before the first lookup: the specialist list loads once.
  await group('ag-main', 'main', 'plain');
  await getDb().run('UPDATE agent_groups SET is_main = 1 WHERE id = ?', 'ag-main');
  await group('ag-rsrch', 'specialists-researcher', 'specialist');
  await group('ag-coder', 'specialists-coder', 'specialist');
  await session('sess-main', 'ag-main', null);
  // A root research task (asked by the main agent) and a research sub-task
  // (asked by the coder).
  await createTask(taskRow({ id: 'task-rsrch-root', specialist_group_id: 'ag-rsrch' }));
  await session('sess-rsrch-root', 'ag-rsrch', 'task-rsrch-root');
  await createTask(taskRow({ id: 'task-coder', specialist_group_id: 'ag-coder', status: 'awaiting_sub_task' }));
  await session('sess-coder', 'ag-coder', 'task-coder');
  await createTask(
    taskRow({
      id: 'task-rsrch-sub',
      specialist_group_id: 'ag-rsrch',
      requester_group_id: null,
      requester_task_id: 'task-coder',
      requester_session_id: 'sess-coder',
      depth: 1,
      chain_delegation_count: 2,
      ancestor_group_ids: '["ag-coder"]',
    }),
  );
  await session('sess-rsrch-sub', 'ag-rsrch', 'task-rsrch-sub');
});
afterAll(async () => {
  await closeDb();
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe('positive control', () => {
  it('(support) the main session is given its memory index and the Zotero library', async () => {
    const c = await contributionFor('sess-main');
    expect(groupOrMemoryMounts(c).map((m) => [m.hostPath, m.readonly])).toEqual([
      [path.join(DATA, 'v2-memory', 'ag-main'), true],
      [path.join(GROUPS, 'main', 'zotero-md'), true],
    ]);
    expect(c.readonlyWorkspace).toBe(false);
  });
});

obligation('invariant.ResearcherKnowledgeIsolation', async () => {
  // Whoever dispatched it — the main agent or another specialist — the
  // researcher's container reaches no group's workspace and no memory index:
  // its own folder read-only, its own provider state, and nothing else from
  // the groups or the indexes.
  for (const sessionId of ['sess-rsrch-root', 'sess-rsrch-sub']) {
    const s = (await getSession(sessionId))!;
    expect(await memoryAccessFor(s)).toBeNull();

    const c = await contributionFor(sessionId);
    expect(groupOrMemoryMounts(c)).toEqual([]);
    expect(c.readonlyWorkspace).toBe(true);
    expect(c.sessionScopedProviderState).toBe(true);
    expect(c.env?.NANOCLAW_MEMORY_ENABLED).toBeUndefined();
    expect(c.env?.NANOCLAW_WORKSPACE_READONLY).toBe('1');
  }
});

obligation('invariant.NotesCreatedByMainAgentOnly', async () => {
  // A note is a file in a group's zettel/notes/. A specialist session can
  // write in no group folder: its own is read-only and no contributor gives
  // it another one writable. (A root task's commit_to_memory lands in the
  // requester's zettel/reports/, never notes/ — specialists results.test.ts.)
  for (const sessionId of ['sess-rsrch-root', 'sess-rsrch-sub', 'sess-coder']) {
    const c = await contributionFor(sessionId);
    expect(c.readonlyWorkspace).toBe(true);
    expect(groupOrMemoryMounts(c).filter((m) => !m.readonly)).toEqual([]);
  }
  // The main agent's session keeps its group folder writable.
  expect((await contributionFor('sess-main')).readonlyWorkspace).toBe(false);
});

obligation('rule-failure.SupersedingNoteWritten.1', async () => {
  // group.specialist != null: a specialist cannot write a superseding note
  // (nor set superseded_by on an old one) — no group folder is writable to it.
  const c = await contributionFor('sess-coder');
  expect(c.readonlyWorkspace).toBe(true);
  expect(groupOrMemoryMounts(c).filter((m) => !m.readonly)).toEqual([]);
});

obligation('rule-failure.SynthesisCandidatesScanned.1', async () => {
  // group.specialist != null: a specialist's session can record no candidate
  // and write no digest — its folder is read-only — and it has no memory
  // index to sample notes from.
  const c = await contributionFor('sess-rsrch-root');
  expect(c.readonlyWorkspace).toBe(true);
  expect(groupOrMemoryMounts(c)).toEqual([]);
  expect(c.env?.NANOCLAW_MEMORY_ENABLED).toBeUndefined();
});
