// Tests for routeResult — specialist session cleanup on task terminal state.
//
// Covers the fix for the "session never closed" bug: when routeResult is
// called for a terminal task, the specialist session must be marked closed
// and its pending inbound messages must be marked failed, so the host sweep
// stops treating the session as live.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createSpecialist, createTask } from './db.js';
import { endActiveInvocationForSession } from './invocation.js';
import { buildPostMortem } from './postmortem.js';
import { writeSessionMessage } from '../../session-manager.js';
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

vi.mock('./postmortem.js', () => ({
  buildPostMortem: vi.fn(() => 'What the specialist was doing:\n• Last tool: WebFetch({})'),
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

describe('failure post-mortem', () => {
  it('appends what the specialist was doing to the failure its requester receives', async () => {
    const { task, specialistGroupId, specialistSessionId, requesterSessionId } = await makeFailedRootTask();
    await routeResult(task);

    expect(buildPostMortem).toHaveBeenCalledWith(specialistGroupId, specialistSessionId);
    const [, sessionId, message] = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
    expect(sessionId).toBe(requesterSessionId);
    expect(JSON.parse((message as { content: string }).content).text).toBe(
      'Specialist task failed: host_restart — container failed to start after 2 restart attempts\n\n' +
        'What the specialist was doing:\n• Last tool: WebFetch({})',
    );
  });

  it('is not built for a completed task', async () => {
    const { task } = await makeFailedRootTask();
    await routeResult({ ...task, status: 'completed', result: 'done', failure_kind: null, failure_detail: null });
    expect(buildPostMortem).not.toHaveBeenCalled();
  });
});

// The parent of a last same-type child is told no further responses will
// follow. That notice was appended only to a text result: a last child that
// returned files was as final, but the parent was not told.
describe('last-turn parent notice', () => {
  async function lastChildOfWaitingParent(): Promise<SpecialistTask> {
    const { specialistGroupId, requesterGroupId, requesterSessionId } = await makeFailedRootTask();
    await createSession({
      id: 'sess-parent',
      agent_group_id: specialistGroupId,
      messaging_group_id: null,
      thread_id: 'task-parent',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      processing_state: 'idle',
      last_active: now(),
      created_at: now(),
    });
    const base = {
      specialist_group_id: specialistGroupId,
      prompt: 'p',
      requester_session_id: requesterSessionId,
      chain_delegation_count: 1,
      ancestor_group_ids: '[]',
      dispatched_at: now(),
      restart_attempt_count: 0,
      failure_kind: null,
      failure_detail: null,
      committed_files: null,
    };
    await createTask({
      ...base,
      id: 'task-parent',
      requester_group_id: requesterGroupId,
      requester_task_id: null,
      depth: 0,
      is_last_same_type_dispatch: 0,
      status: 'awaiting_sub_task',
      closed_at: null,
      result: null,
      pending_sub_task_id: null,
    });
    const child: SpecialistTask = {
      ...base,
      id: 'task-last',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      depth: 1,
      is_last_same_type_dispatch: 1,
      status: 'completed',
      closed_at: now(),
      result: 'see the report',
      pending_sub_task_id: null,
    };
    await createTask(child);
    await getDb().run("UPDATE specialist_tasks SET pending_sub_task_id = 'task-last' WHERE id = 'task-parent'");
    return child;
  }

  function parentText(): string {
    const [, sessionId, message] = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
    expect(sessionId).toBe('sess-parent');
    return JSON.parse((message as { content: string }).content).text as string;
  }

  it('follows a text result', async () => {
    await routeResult(await lastChildOfWaitingParent());
    expect(parentText()).toContain('[Final iteration: no further responses');
  });

  it('follows a result that carries files', async () => {
    const child = await lastChildOfWaitingParent();
    const transfer = {
      id: 'xfer-last',
      task_id: child.id,
      sender_invocation_id: 'inv-last',
      result_text: 'see /workspace/ipc-in/xfer-last/report.md',
      commit_to_memory: 0,
      file_count: 1,
      sent_at: now(),
      status: 'pending',
      recipient_session_id: null,
    } as unknown as Parameters<typeof routeResult>[1];

    await routeResult(child, transfer);

    expect(parentText()).toBe(
      'see /workspace/ipc-in/xfer-last/report.md\n\n[Final iteration: no further responses will follow from this specialist. Incorporate this as your final input and conclude your work.]',
    );
  });
});

// Whether a main-agent transfer's files are done with is decided by the
// message that carried them, so routing records that message on the transfer
// — chosen before the message is written, so a fast container cannot handle
// it before the link exists.
describe('a root result with staged files', () => {
  it('records the message that carries it on the transfer', async () => {
    const { task, requesterSessionId } = await makeFailedRootTask();
    const completed = { ...task, status: 'completed' as const, result: 'r', failure_kind: null, failure_detail: null };
    await getDb().run(
      `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at)
       VALUES ('inv-x', ?, NULL, '/x/out', '/x/in', ?)`,
      requesterSessionId,
      now(),
    );
    await getDb().run(
      `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status)
       VALUES ('xfer-root', ?, 'inv-x', 'see the report', 0, 1, ?, 'pending')`,
      task.id,
      now(),
    );
    const transfer = (await getDb().get("SELECT * FROM container_transfers WHERE id = 'xfer-root'")) as Parameters<
      typeof routeResult
    >[1];

    await routeResult(completed, transfer);

    const [, sessionId, message] = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
    expect(sessionId).toBe(requesterSessionId);
    const row = (await getDb().get("SELECT routed_message_id FROM container_transfers WHERE id = 'xfer-root'")) as {
      routed_message_id: string;
    };
    expect(row.routed_message_id).toBe((message as { id: string }).id);
  });
});
