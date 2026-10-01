/**
 * `ncl groups delete` on groups the fork's modules have written to.
 *
 * The core cascade knew only core tables, so a group with indexed memory,
 * Zotero state or specialist history hit a foreign key on the final
 * `DELETE FROM agent_groups` and rolled back. The archive cascaded those
 * tables inline; the rebuild onto upstream dropped it. Module steps now remove
 * their own rows first.
 *
 * Driven through the real dispatch with the host caller — the path an approved
 * delete takes — against a graph that crosses groups: a root task the main
 * group requested of a specialist, a sub-task that specialist requested of a
 * second one, invocations and transfers on both sides.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./container-restart.js', () => ({ restartAgentGroupContainers: vi.fn().mockResolvedValue(0) }));
vi.mock('./config.js', async () => ({
  ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-group-delete',
}));

import { dispatch } from './cli/dispatch.js';
import './cli/resources/groups.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';
// Module tables exist only where their module registered its migrations.
import './db/migrations/module-memory.js';
import './db/migrations/module-specialists.js';
import './db/migrations/module-specialists-file-handover.js';
import './db/migrations/module-specialists-processing-state.js';
import './db/migrations/module-zotero.js';
import './modules/memory/group-delete.js';
import './modules/specialists/group-delete.js';
import './modules/zotero/group-delete.js';

const MAIN = 'ag-main';
const RESEARCHER = 'ag-rsrch';
const CODER = 'ag-coder';
const T = '2026-10-01T00:00:00.000Z';

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await getDb().run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...Object.values(row),
  );
}

async function count(table: string, where = '1=1', ...params: unknown[]): Promise<number> {
  const row = (await getDb().get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)) as { n: number };
  return row.n;
}

async function session(id: string, group: string): Promise<void> {
  await createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: T,
  });
}

/**
 * main ──root task──▶ researcher ──sub-task──▶ coder
 *
 * Each task has an invocation in its specialist's session; the sub-task's
 * result transfer goes from the coder's invocation back to the researcher's
 * session. The main group also has memory, Zotero state and a message policy.
 */
async function seed(): Promise<void> {
  for (const [id, folder] of [
    [MAIN, 'main'],
    [RESEARCHER, 'researcher'],
    [CODER, 'coder'],
  ]) {
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: T });
  }
  for (const id of [RESEARCHER, CODER]) {
    await insert('specialists', { agent_group_id: id, is_memory_provider: 0, created_at: T });
  }
  await session('s-main', MAIN);
  await session('s-rsrch', RESEARCHER);
  await session('s-coder', CODER);

  await insert('specialist_tasks', {
    id: 'task-root',
    specialist_group_id: RESEARCHER,
    prompt: 'research',
    requester_group_id: MAIN,
    requester_session_id: 's-main',
    status: 'awaiting_sub_task',
    dispatched_at: T,
  });
  await insert('specialist_tasks', {
    id: 'task-sub',
    specialist_group_id: CODER,
    prompt: 'code',
    requester_task_id: 'task-root',
    requester_session_id: 's-rsrch',
    status: 'running',
    dispatched_at: T,
  });
  await getDb().run("UPDATE specialist_tasks SET pending_sub_task_id = 'task-sub' WHERE id = 'task-root'");

  for (const [id, sess, task] of [
    ['inv-rsrch', 's-rsrch', 'task-root'],
    ['inv-coder', 's-coder', 'task-sub'],
  ]) {
    await insert('invocations', {
      id,
      session_id: sess,
      task_id: task,
      ipc_out_host_path: '/o',
      ipc_in_host_path: '/i',
      started_at: T,
    });
    await insert('ipc_out_mounts', { id: `out-${id}`, invocation_id: id });
    await insert('ipc_in_mounts', { id: `in-${id}`, invocation_id: id });
  }
  await insert('container_transfers', {
    id: 'xfer-sub',
    task_id: 'task-sub',
    sender_invocation_id: 'inv-coder',
    result_text: 'done',
    sent_at: T,
    recipient_session_id: 's-rsrch',
  });
  await insert('transfer_files', { id: 'tf-1', transfer_id: 'xfer-sub', original_name: 'a.md', host_path: '/a' });

  await insert('memory_files', { id: 'mf-1', group_id: MAIN, path: 'memory/a.md', content_hash: 'h', created_at: T });
  await insert('memory_chunks', {
    id: 'mc-1',
    file_id: 'mf-1',
    start_line: 1,
    end_line: 2,
    content: 'x',
    hash: 'h',
    indexed_at: T,
  });
  await insert('zotero_sync_state', { agent_group_id: MAIN, updated_at: T });
  await insert('agent_message_policies', {
    from_agent_group_id: MAIN,
    to_agent_group_id: RESEARCHER,
    approver: 'u',
    created_at: T,
  });
}

async function deleteGroup(id: string) {
  return dispatch({ id: `req-${id}`, command: 'groups-delete', args: { id } }, { caller: 'host' });
}

beforeEach(async () => {
  fs.mkdirSync('/tmp/nanoclaw-test-group-delete', { recursive: true });
  await runMigrations(await initTestDb());
  await seed();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync('/tmp/nanoclaw-test-group-delete', { recursive: true, force: true });
});

describe('groups delete across module tables', () => {
  it('deletes the main group with its memory, Zotero state, requested tasks and policies', async () => {
    const resp = await deleteGroup(MAIN);
    expect(resp.ok).toBe(true);

    expect(await count('agent_groups', 'id = ?', MAIN)).toBe(0);
    expect(await count('memory_files')).toBe(0);
    expect(await count('memory_chunks')).toBe(0);
    expect(await count('zotero_sync_state')).toBe(0);
    expect(await count('agent_message_policies')).toBe(0);
    // The root task it requested goes, with the invocation that ran it in the
    // researcher's session.
    expect(await count('specialist_tasks', "id = 'task-root'")).toBe(0);
    expect(await count('invocations', "id = 'inv-rsrch'")).toBe(0);
    // The sub-task belongs to the coder and survives, minus its requester pointer.
    expect(await getDb().get("SELECT requester_task_id FROM specialist_tasks WHERE id = 'task-sub'")).toEqual({
      requester_task_id: null,
    });
    expect(await count('agent_groups', 'id IN (?, ?)', RESEARCHER, CODER)).toBe(2);

    const removed = (resp as { ok: true; data: { removed: { modules: Record<string, number> } } }).data.removed;
    expect(removed.modules).toMatchObject({ memory: 2, zotero: 1, agent_message_policies: 1 });
    expect(removed.modules.specialists).toBeGreaterThan(0);
  });

  it('deletes a specialist that is mid-task in both directions', async () => {
    // The researcher ran the root task and requested the sub-task; the coder's
    // transfer is addressed to its session.
    const resp = await deleteGroup(RESEARCHER);
    expect(resp.ok).toBe(true);

    expect(await count('agent_groups', 'id = ?', RESEARCHER)).toBe(0);
    expect(await count('specialists', 'agent_group_id = ?', RESEARCHER)).toBe(0);
    expect(await count('specialist_tasks')).toBe(0); // root it ran, sub it requested
    expect(await count('invocations')).toBe(0);
    expect(await count('container_transfers')).toBe(0);
    expect(await count('transfer_files')).toBe(0);
    expect(await count('ipc_out_mounts')).toBe(0);
    expect(await count('ipc_in_mounts')).toBe(0);
    // Untouched: the other groups, and main's own memory.
    expect(await count('agent_groups', 'id IN (?, ?)', MAIN, CODER)).toBe(2);
    expect(await count('memory_files')).toBe(1);
  });

  it('deletes a sub-task specialist, leaving its requester waiting on nothing', async () => {
    const resp = await deleteGroup(CODER);
    expect(resp.ok).toBe(true);

    expect(await count('specialist_tasks', "id = 'task-sub'")).toBe(0);
    expect(await getDb().get("SELECT pending_sub_task_id FROM specialist_tasks WHERE id = 'task-root'")).toEqual({
      pending_sub_task_id: null,
    });
    expect(await count('container_transfers')).toBe(0);
    expect(await count('invocations', "id = 'inv-rsrch'")).toBe(1);
  });

  it('rolls the whole delete back when a module step fails', async () => {
    const { registerGroupDeleteStep } = await import('./group-delete.js');
    registerGroupDeleteStep({
      name: 'explodes-for-coder',
      async run(_db, id) {
        if (id === CODER) throw new Error('module step failed');
        return 0;
      },
    });

    const resp = await deleteGroup(CODER);
    expect(resp.ok).toBe(false);
    // Nothing went, including the rows earlier steps had already removed.
    expect(await count('agent_groups', 'id = ?', CODER)).toBe(1);
    expect(await count('specialist_tasks', "id = 'task-sub'")).toBe(1);
    expect(await count('container_transfers')).toBe(1);
  });
});
