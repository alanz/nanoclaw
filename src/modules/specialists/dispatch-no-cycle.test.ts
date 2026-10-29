/**
 * There is no cycle check (specs/specialists.allium, owner decision
 * 2026-10-27): a parent runs one sub-task at a time, so a chain is a single
 * line, and the depth / chain-count / same-type limits bound it. A specialist
 * may dispatch to its own group (a researcher working in chunks) and back to
 * a group met earlier in the chain. The ancestry is the ordered list of the
 * groups above a task, repeats included, so depth = its length.
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

/** A running task of `group`, a sub-task whose chain above it is `ancestors`. */
async function runningTask(group: string, ancestors: string[]): Promise<Session> {
  await createAgentGroup({ id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: now() });
  for (const g of new Set(['ag-r', 'ag-w'])) await specialistGroup(g);
  const session = {
    id: 'sess-parent',
    agent_group_id: group,
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
    specialist_group_id: group,
    prompt: 'research',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-parent',
    depth: ancestors.length,
    chain_delegation_count: ancestors.length + 1,
    ancestor_group_ids: JSON.stringify(ancestors),
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
  return session as unknown as Session;
}

async function dispatchedChild(): Promise<{ ancestors: string[]; depth: number; status: string }> {
  const parent = await getTask('task-parent');
  expect(parent!.status).toBe('awaiting_sub_task');
  const child = await getTask(parent!.pending_sub_task_id!);
  return { ancestors: JSON.parse(child!.ancestor_group_ids), depth: child!.depth, status: child!.status };
}

beforeEach(async () => {
  written.length = 0;
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
});

describe('sub-task dispatch has no cycle check', () => {
  it('a specialist may dispatch to its own group, below a chunk of itself (R -> R -> R)', async () => {
    const session = await runningTask('ag-r', ['ag-r']);
    await handleDispatchSubTask({ specialist_group_id: 'ag-r', prompt: 'next chunk' }, session);

    expect(written.filter((t) => t.includes('rejected'))).toEqual([]);
    expect(await dispatchedChild()).toEqual({ ancestors: ['ag-r', 'ag-r'], depth: 2, status: 'queued' });
  });

  it('a chain may return to a group met earlier (R -> W -> R)', async () => {
    const session = await runningTask('ag-w', ['ag-r']);
    await handleDispatchSubTask({ specialist_group_id: 'ag-r', prompt: 'check this' }, session);

    expect(written.filter((t) => t.includes('rejected'))).toEqual([]);
    expect(await dispatchedChild()).toEqual({ ancestors: ['ag-r', 'ag-w'], depth: 2, status: 'queued' });
  });

  it('the depth limit still bounds a self-dispatching chain', async () => {
    const session = await runningTask('ag-r', ['ag-r', 'ag-r', 'ag-r', 'ag-r']);
    await handleDispatchSubTask({ specialist_group_id: 'ag-r', prompt: 'one more' }, session);

    expect(written).toContain('sub-task rejected: depth limit reached');
    expect((await getTask('task-parent'))!.status).toBe('running');
  });
});
