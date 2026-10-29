/**
 * Deleting an agent group ends the specialist work that depends on it (spec:
 * SpecialistTasksFailedOnGroupDeleted). The row delete alone only cleared
 * pointers: a surviving parent waiting on a deleted child sat out the 4h task
 * timeout, and a surviving child of a deleted parent ran on with no requester.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
}));
vi.mock('../../session-manager.js', () => ({
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(async () => {}),
  withExistingMailboxSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));
vi.mock('./postmortem.js', () => ({ buildPostMortem: vi.fn(() => null) }));
vi.mock('./invocation.js', () => ({
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession, getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { createSpecialist, createTask, getTask } from './db.js';
import { failTasksOfDeletedGroup } from './group-delete.js';
import type { SpecialistTask } from './types.js';

const now = () => new Date().toISOString();

async function session(id: string, group: string, thread: string | null): Promise<void> {
  await createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: thread,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });
}

/** A task with its per-task session (thread = task id). */
async function task(
  id: string,
  group: string,
  status: SpecialistTask['status'],
  requester: { group: string } | { task: string },
): Promise<void> {
  await session(`sess-${id}`, group, id);
  await createTask({
    id,
    specialist_group_id: group,
    prompt: 'p',
    requester_group_id: 'group' in requester ? requester.group : null,
    requester_task_id: 'task' in requester ? requester.task : null,
    requester_session_id: 'group' in requester ? 'sess-main' : `sess-${requester.task}`,
    depth: 'group' in requester ? 0 : 1,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status,
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  });
}

const waitingOn = (parent: string, child: string) =>
  getDb().run('UPDATE specialist_tasks SET pending_sub_task_id = ? WHERE id = ?', child, parent);

const sentTo = (sessionId: string): string[] =>
  vi
    .mocked(writeSessionMessage)
    .mock.calls.filter(([, s]) => s === sessionId)
    .map(([, , m]) => JSON.parse((m as { content: string }).content).text as string);

beforeEach(async () => {
  vi.clearAllMocks();
  await runMigrations(await initTestDb());
  for (const id of ['ag-main', 'ag-gone', 'ag-kept']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  for (const id of ['ag-gone', 'ag-kept']) {
    await createSpecialist({
      agent_group_id: id,
      is_memory_provider: 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: now(),
    });
  }
  await session('sess-main', 'ag-main', null);
});
afterEach(async () => {
  await closeDb();
});

describe('deleting a group with live specialist work', () => {
  it('fails its task and tells the surviving parent waiting on it', async () => {
    await task('task-parent', 'ag-kept', 'awaiting_sub_task', { group: 'ag-main' });
    await task('task-child', 'ag-gone', 'running', { task: 'task-parent' });
    await waitingOn('task-parent', 'task-child');

    await failTasksOfDeletedGroup('ag-gone');

    const child = (await getTask('task-child'))!;
    expect(child.status).toBe('failed');
    expect(child.failure_kind).toBe('group_deleted');
    expect((await getTask('task-parent'))!.status).toBe('running');
    expect(sentTo('sess-task-parent').join('\n')).toContain('group_deleted');
  });

  it('cancels a surviving child chain below its task', async () => {
    await task('task-parent', 'ag-gone', 'awaiting_sub_task', { group: 'ag-main' });
    await task('task-child', 'ag-kept', 'running', { task: 'task-parent' });
    await waitingOn('task-parent', 'task-child');

    await failTasksOfDeletedGroup('ag-gone');

    expect((await getTask('task-parent'))!.failure_kind).toBe('group_deleted');
    const child = (await getTask('task-child'))!;
    expect(child.status).toBe('failed');
    expect(child.failure_detail).toBe('cancelled: an ancestor specialist task ended');
    expect((await getSession('sess-task-child'))!.status).toBe('closed');
  });

  it('ends a task requested by the deleted group without messaging or waking it', async () => {
    await task('task-root', 'ag-kept', 'running', { group: 'ag-main' });

    await failTasksOfDeletedGroup('ag-main');

    expect((await getTask('task-root'))!.failure_kind).toBe('group_deleted');
    expect((await getSession('sess-task-root'))!.status).toBe('closed');
    expect(sentTo('sess-main')).toEqual([]);
  });

  it('leaves finished tasks alone', async () => {
    await task('task-done', 'ag-gone', 'completed', { group: 'ag-main' });

    expect(await failTasksOfDeletedGroup('ag-gone')).toBe(0);
    expect((await getTask('task-done'))!.status).toBe('completed');
  });
});
