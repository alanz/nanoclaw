/**
 * A specialist session works for exactly one task: its thread_id. The handlers
 * found "the task" as the newest live task in the specialist's group instead
 * (P3), so with two tasks for one specialist running at once, the older
 * session's delivery completed the newer task and its dispatch suspended it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./routing.js', () => ({ routeResult: vi.fn(async () => {}) }));
vi.mock('../../container-runner.js', () => ({
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
vi.mock('../../channels/null-channel.js', () => ({ getNullMessagingGroupId: () => null }));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { createSpecialist, createTask, getTask } from './db.js';
import { handleDeliverSpecialistResult } from './delivery.js';
import { handleDispatchSubTask } from './dispatch.js';
import type { SpecialistTask } from './types.js';

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function specialist(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: iso(0) });
  await createSpecialist({
    agent_group_id: id,
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: iso(0),
  });
}

async function liveTask(id: string, dispatchedAgo: number): Promise<Session> {
  const session = {
    id: `sess-${id}`,
    agent_group_id: 'ag-rsrch',
    messaging_group_id: null,
    thread_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    processing_state: 'idle',
    last_active: iso(0),
    created_at: iso(dispatchedAgo),
  } as const;
  await createSession(session);
  const task: SpecialistTask = {
    id,
    specialist_group_id: 'ag-rsrch',
    prompt: id,
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 0,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    dispatched_at: iso(dispatchedAgo),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };
  await createTask(task);
  return session as unknown as Session;
}

let older: Session;

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: iso(0) });
  await specialist('ag-rsrch');
  await specialist('ag-coder');
  await createSession({
    id: 'sess-main',
    agent_group_id: 'ag-main',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: iso(0),
    created_at: iso(0),
  });
  older = await liveTask('task-older', 60_000);
  await liveTask('task-newer', 1_000); // the one a by-group lookup picks
});
afterEach(async () => {
  await closeDb();
});

describe('a specialist with two live tasks', () => {
  it("completes the delivering session's own task", async () => {
    await handleDeliverSpecialistResult({ result_text: 'older is done' }, older);

    expect((await getTask('task-older'))!.status).toBe('completed');
    expect((await getTask('task-newer'))!.status).toBe('running');
  });

  it("suspends the dispatching session's own task", async () => {
    await handleDispatchSubTask({ specialist_group_id: 'ag-coder', prompt: 'help' }, older);

    expect((await getTask('task-older'))!.status).toBe('awaiting_sub_task');
    expect((await getTask('task-newer'))!.status).toBe('running');
  });
});
