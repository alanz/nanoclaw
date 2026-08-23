// Tests for routeResult — specialist session cleanup on task terminal state.
//
// Covers the fix for the "session never closed" bug: when routeResult is
// called for a terminal task, the specialist session must be marked closed
// and its pending inbound messages must be marked failed, so the host sweep
// stops treating the session as live.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createSpecialist, createTask } from './db.js';
import { endActiveInvocationForSession } from './invocation.js';
import { routeResult } from './routing.js';
import type { SpecialistTask } from './types.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
  // closeSpecialistSession goes through the mailbox seam now. Resolving to
  // undefined is what an unprovisioned session looks like, which is the case
  // this file cares about: cleanup must not throw when there is no mailbox.
  withExistingMailboxSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./invocation.js', () => ({
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

let seq = 0;
function uid(prefix: string) {
  return `${prefix}-${++seq}`;
}

interface TaskSetup {
  specialistGroupId: string;
  specialistSessionId: string;
  requesterGroupId: string;
  requesterSessionId: string;
  task: SpecialistTask;
}

async function makeFailedRootTask(): Promise<TaskSetup> {
  const specialistGroupId = uid('ag-spec');
  const specialistSessionId = uid('sess-spec');
  const requesterGroupId = uid('ag-main');
  const requesterSessionId = uid('sess-main');
  const taskId = uid('task');

  await createAgentGroup({
    id: specialistGroupId,
    name: 'Specialist',
    folder: specialistGroupId,
    agent_provider: null,
    created_at: now(),
  });
  await createSpecialist({
    agent_group_id: specialistGroupId,
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: requesterGroupId,
    name: 'Main',
    folder: requesterGroupId,
    agent_provider: null,
    created_at: now(),
  });

  // Specialist session — thread_id = task id, as createSpecialistSession sets it.
  await createSession({
    id: specialistSessionId,
    agent_group_id: specialistGroupId,
    messaging_group_id: null,
    thread_id: taskId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });

  // Requester session (main group) — routeResult delivers the result here.
  await createSession({
    id: requesterSessionId,
    agent_group_id: requesterGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });

  const task: SpecialistTask = {
    id: taskId,
    specialist_group_id: specialistGroupId,
    prompt: 'do work',
    requester_group_id: requesterGroupId,
    requester_task_id: null,
    requester_session_id: requesterSessionId,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'failed',
    dispatched_at: now(),
    restart_attempt_count: 3,
    closed_at: now(),
    result: null,
    failure_kind: 'host_restart',
    failure_detail: 'container failed to start after 2 restart attempts',
    pending_sub_task_id: null,
    committed_files: null,
  };
  await createTask(task);

  return { specialistGroupId, specialistSessionId, requesterGroupId, requesterSessionId, task };
}

// ── test setup ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  seq = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeDb();
});

// ── session cleanup on terminal state ────────────────────────────────────────

describe('specialist session cleanup on terminal task', () => {
  it('marks the specialist session closed when a failed task is routed', async () => {
    const { specialistSessionId, task } = await makeFailedRootTask();

    expect((await getSession(specialistSessionId))?.status).toBe('active');
    await routeResult(task);
    expect((await getSession(specialistSessionId))?.status).toBe('closed');
  });

  it('marks the specialist session closed when a completed task is routed', async () => {
    const setup = await makeFailedRootTask();
    const completedTask: SpecialistTask = {
      ...setup.task,
      status: 'completed',
      result: 'done',
      failure_kind: null,
      failure_detail: null,
    };

    await routeResult(completedTask);

    expect((await getSession(setup.specialistSessionId))?.status).toBe('closed');
  });

  it('leaves the requester session active after routing', async () => {
    // The requester (main group) session must stay active — it's still live
    // and will receive the result message.
    const { requesterSessionId, task } = await makeFailedRootTask();

    await routeResult(task);

    expect((await getSession(requesterSessionId))?.status).toBe('active');
  });

  // P13: the invocation end was not awaited — its cleanup raced the session
  // close, and a failure escaped as an unhandled rejection. Now awaited; a
  // failure is logged and the close still happens.
  it('finishes ending the invocation before the session is closed', async () => {
    const { task, specialistSessionId } = await makeFailedRootTask();
    let statusWhenEnded: string | undefined;
    vi.mocked(endActiveInvocationForSession).mockImplementationOnce(async (sessionId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      statusWhenEnded = (await getSession(sessionId))?.status;
    });

    await routeResult(task);

    expect(statusWhenEnded).toBe('active');
    expect((await getSession(specialistSessionId))?.status).toBe('closed');
  });

  it('still closes the specialist session when ending its invocation fails', async () => {
    const { task, specialistSessionId } = await makeFailedRootTask();
    vi.mocked(endActiveInvocationForSession).mockRejectedValueOnce(new Error('ipc cleanup failed'));

    await expect(routeResult(task)).resolves.toBeUndefined();

    expect(endActiveInvocationForSession).toHaveBeenCalledWith(specialistSessionId);
    expect((await getSession(specialistSessionId))?.status).toBe('closed');
  });

  it('does not throw when the specialist session was never provisioned', async () => {
    // withExistingMailboxSession resolves undefined for a session with no
    // mailbox on disk; cleanup must handle that without crashing.
    const { task } = await makeFailedRootTask();
    await expect(routeResult(task)).resolves.not.toThrow();
  });
});
