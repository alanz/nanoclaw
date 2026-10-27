/**
 * A specialist task runs in a session on the null channel. Dispatch wrote the
 * task row first and then created that session, which throws when the null
 * channel is missing: the task was left queued with no session, which the
 * recovery sweep (it joins tasks to live sessions) never sees, so it never
 * timed out. The spec requires the null channel before anything is created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => [] as string[]);

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
}));
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(async (_ag: string, _s: string, msg: { content: string }) => {
    written.push(JSON.parse(msg.content).text);
  }),
  withExistingMailboxSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));
vi.mock('../../channels/null-channel.js', () => ({
  getNullMessagingGroupId: async () => {
    throw new Error('Null channel MessagingGroup not found');
  },
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { createSpecialist, createTask, getTask, setMainGroup } from './db.js';
import { handleDispatchSpecialist, handleDispatchSubTask } from './dispatch.js';

const now = () => new Date().toISOString();

async function session(id: string, group: string, thread: string | null): Promise<Session> {
  const s = {
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: thread,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  } as const;
  await createSession(s);
  return s as unknown as Session;
}

const taskCount = async () => ((await getDb().get('SELECT COUNT(*) AS n FROM specialist_tasks')) as { n: number }).n;

beforeEach(async () => {
  written.length = 0;
  await runMigrations(await initTestDb());
  for (const id of ['ag-main', 'ag-spec']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  await setMainGroup('ag-main');
  await createSpecialist({
    agent_group_id: 'ag-spec',
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
});
afterEach(async () => {
  await closeDb();
});

describe('dispatch without the null channel', () => {
  it('creates no root task and tells the main agent', async () => {
    const main = await session('sess-main', 'ag-main', null);

    await handleDispatchSpecialist({ specialist_group_id: 'ag-spec', prompt: 'research' }, main);

    expect(await taskCount()).toBe(0);
    expect(written.join('\n')).toContain('dispatch_specialist failed');
  });

  it('creates no sub-task and leaves the parent running', async () => {
    const parentSession = await session('sess-parent', 'ag-spec', 'task-parent');
    await createTask({
      id: 'task-parent',
      specialist_group_id: 'ag-spec',
      prompt: 'p',
      requester_group_id: 'ag-main',
      requester_task_id: null,
      requester_session_id: 'sess-parent',
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
    });

    await handleDispatchSubTask({ specialist_group_id: 'ag-spec', prompt: 'a chunk' }, parentSession);

    expect(await taskCount()).toBe(1);
    expect((await getTask('task-parent'))!.status).toBe('running');
    expect(written.join('\n')).toContain('dispatch_sub_task failed');
  });
});
