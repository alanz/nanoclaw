/**
 * A specialist that delegates in its first minute: its task is still `queued`
 * (the recovery sweep advances it to `running` once a minute), yet the
 * dispatch itself proves its container is up. It was rejected — "parent task
 * is in state queued, expected running" — and had to retry (seen live).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => [] as string[]);

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
}));
vi.mock('../../session-manager.js', () => ({
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(async (_ag: string, _s: string, msg: { content: string }) => {
    written.push(JSON.parse(msg.content).text);
  }),
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
import { handleDispatchSubTask } from './dispatch.js';
import type { SpecialistTask } from './types.js';

const now = () => new Date().toISOString();

async function specialistGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  await createSpecialist({
    agent_group_id: id,
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
}

async function parentInState(status: SpecialistTask['status']): Promise<Session> {
  await createAgentGroup({ id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: now() });
  await specialistGroup('ag-parent');
  await specialistGroup('ag-child');
  const session = {
    id: 'sess-parent',
    agent_group_id: 'ag-parent',
    messaging_group_id: null,
    thread_id: 'task-parent',
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  } as const;
  await createSession(session);
  await createTask({
    id: 'task-parent',
    specialist_group_id: 'ag-parent',
    prompt: 'research',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-parent',
    depth: 0,
    chain_delegation_count: 0,
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
  return session as unknown as Session;
}

beforeEach(async () => {
  written.length = 0;
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
});

describe('dispatch_sub_task from a parent the sweep has not yet seen start', () => {
  it.each(['queued', 'awaiting_restart'] as const)('accepts it from a %s parent', async (status) => {
    const session = await parentInState(status);

    await handleDispatchSubTask({ specialist_group_id: 'ag-child', prompt: 'look at the code' }, session);

    expect(written.filter((t) => t.includes('failed'))).toEqual([]);
    const parent = await getTask('task-parent');
    expect(parent!.status).toBe('awaiting_sub_task');
    expect(parent!.pending_sub_task_id).toBeTruthy();
  });
});
