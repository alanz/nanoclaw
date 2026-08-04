// Tests for sweepSpecialistTasks — the recovery sweep in recovery.ts.
//
// Covered rules (specialists.allium):
//   SubTaskAwaitTimedOut        (retries remain → awaiting_restart + cancel child)
//   SubTaskAwaitExhausted       (retries exhausted → failed + cancel child)
//   ChildSubtreeCancelledOnSubTaskAwaitExhausted (fires on timeout w/ pending child)
//   SpecialistTaskTimedOut      (global timeout — also cancels pending child)
//   crash detection scope fix   (awaiting_sub_task excluded from crash detection)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { createSpecialist, createTask, getTask } from './db.js';
import { sweepSpecialistTasks } from './recovery.js';
import type { SpecialistTask } from './types.js';

vi.mock('../../container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeOrQueue: vi.fn().mockResolvedValue(undefined),
  // Default: no boot crashes, so a queued task reads as "waiting for a slot"
  // and the pre-existing queued-exclusion behaviour is unchanged.
  getBootCrashState: vi.fn().mockReturnValue({ count: 0, stderrTail: [] }),
  clearBootCrashState: vi.fn(),
}));

vi.mock('./routing.js', () => ({
  routeResult: vi.fn().mockResolvedValue(undefined),
}));

import { routeResult } from './routing.js';

// ── helpers ──────────────────────────────────────────────────────────────────

let taskSeq = 0;
let groupSeq = 0;
let sessSeq = 0;

function uniqueId(prefix: string) {
  return `${prefix}-${++taskSeq}-${Math.random().toString(36).slice(2, 5)}`;
}

function isoAgo(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

/**
 * Create a minimal specialist group + session + task triple in the DB.
 * Returns the created task (re-fetched after insert so all defaults are populated).
 */
function makeSpecialistTask(opts: {
  status: SpecialistTask['status'];
  dispatchedAgo?: number; // ms ago — defaults to 1 second
  restartAttemptCount?: number;
  pendingSubTaskId?: string | null;
  result?: string;
  failureKind?: string;
  failureDetail?: string;
  closedAt?: string;
}): SpecialistTask {
  const groupId = `ag-spec-${++groupSeq}`;
  const sessId = `sess-${++sessSeq}`;
  const taskId = uniqueId('task');
  const now = new Date().toISOString();

  createAgentGroup({
    id: groupId,
    name: `Specialist ${groupId}`,
    folder: groupId,
    agent_provider: null,
    created_at: now,
  });
  createSpecialist({
    agent_group_id: groupId,
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now,
  });
  createSession({
    id: sessId,
    agent_group_id: groupId,
    messaging_group_id: null,
    thread_id: taskId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now,
    created_at: now,
  });

  const dispatchedAt = isoAgo(opts.dispatchedAgo ?? 1000);
  const task: SpecialistTask = {
    id: taskId,
    specialist_group_id: groupId,
    prompt: 'do work',
    requester_group_id: 'main-group',
    requester_task_id: null,
    requester_session_id: sessId,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: opts.status,
    dispatched_at: dispatchedAt,
    restart_attempt_count: opts.restartAttemptCount ?? 0,
    closed_at: opts.closedAt ?? null,
    result: opts.result ?? null,
    failure_kind: opts.failureKind ?? null,
    failure_detail: opts.failureDetail ?? null,
    pending_sub_task_id: opts.pendingSubTaskId ?? null,
    committed_files: null,
  };
  createTask(task);
  return getTask(taskId)!;
}

// ── test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  // 'main-group' is used as requester_group_id; it must exist in agent_groups.
  createAgentGroup({
    id: 'main-group',
    name: 'Main Group',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  vi.clearAllMocks();
  taskSeq = 0;
  groupSeq = 0;
  sessSeq = 0;
});

afterEach(() => {
  closeDb();
});

// ── SubTaskAwaitTimedOut ──────────────────────────────────────────────────────

describe('SubTaskAwaitTimedOut rule', () => {
  it('transitions awaiting_sub_task parent to awaiting_restart when child is overdue and retries remain', async () => {
    const overdueMs = SPECIALISTS_CONFIG.maxSubTaskAwaitMs + 1000;
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: overdueMs });
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: 0,
    });

    await sweepSpecialistTasks();

    const updatedParent = getTask(parent.id)!;
    expect(updatedParent.status).toBe('awaiting_restart');
    expect(updatedParent.restart_attempt_count).toBe(1);
    expect(updatedParent.pending_sub_task_id).toBeNull();
  });

  it('increments restart_attempt_count on each sub-task await timeout', async () => {
    const overdueMs = SPECIALISTS_CONFIG.maxSubTaskAwaitMs + 1000;
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: overdueMs });
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: 1,
    });

    await sweepSpecialistTasks();

    const updatedParent = getTask(parent.id)!;
    expect(updatedParent.status).toBe('awaiting_restart');
    expect(updatedParent.restart_attempt_count).toBe(2);
  });

  it('cancels the pending child subtree when transitioning to awaiting_restart', async () => {
    const overdueMs = SPECIALISTS_CONFIG.maxSubTaskAwaitMs + 1000;
    const grandchild = makeSpecialistTask({ status: 'running', dispatchedAgo: overdueMs });
    const child = makeSpecialistTask({
      status: 'awaiting_sub_task',
      dispatchedAgo: overdueMs,
      pendingSubTaskId: grandchild.id,
    });
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: 0,
    });

    await sweepSpecialistTasks();

    const updatedParent = getTask(parent.id)!;
    const updatedChild = getTask(child.id)!;
    const updatedGrandchild = getTask(grandchild.id)!;

    expect(updatedParent.status).toBe('awaiting_restart');
    // ChildSubtreeCancelledOnParentCrash: child and grandchild are cancelled
    expect(updatedChild.status).toBe('failed');
    expect(updatedChild.failure_kind).toBe('execution_error');
    expect(updatedGrandchild.status).toBe('failed');
  });

  it('does not fire when the child is not yet overdue', async () => {
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: 1000 }); // 1 second ago
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: 0,
    });

    await sweepSpecialistTasks();

    expect(getTask(parent.id)!.status).toBe('awaiting_sub_task');
  });

  it('does not fire when pending_sub_task_id is null', async () => {
    // Degenerate state: awaiting_sub_task with no child recorded.
    // Should not crash and should not alter the task.
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: null,
    });

    await sweepSpecialistTasks();

    expect(getTask(parent.id)!.status).toBe('awaiting_sub_task');
  });
});

// ── SubTaskAwaitExhausted ─────────────────────────────────────────────────────

describe('SubTaskAwaitExhausted rule', () => {
  it('fails the parent with kind=timeout when retries are exhausted', async () => {
    const overdueMs = SPECIALISTS_CONFIG.maxSubTaskAwaitMs + 1000;
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: overdueMs });
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: SPECIALISTS_CONFIG.maxRestartRetries, // retries exhausted
    });

    await sweepSpecialistTasks();

    const updatedParent = getTask(parent.id)!;
    expect(updatedParent.status).toBe('failed');
    expect(updatedParent.failure_kind).toBe('timeout');
    expect(updatedParent.closed_at).not.toBeNull();
    expect(updatedParent.pending_sub_task_id).toBeNull();
  });

  it('cancels the pending child subtree on exhaustion', async () => {
    const overdueMs = SPECIALISTS_CONFIG.maxSubTaskAwaitMs + 1000;
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: overdueMs });
    makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: SPECIALISTS_CONFIG.maxRestartRetries,
    });

    await sweepSpecialistTasks();

    expect(getTask(child.id)!.status).toBe('failed');
    expect(getTask(child.id)!.failure_kind).toBe('execution_error');
  });

  it('calls routeResult so the failure is delivered to the requester', async () => {
    const overdueMs = SPECIALISTS_CONFIG.maxSubTaskAwaitMs + 1000;
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: overdueMs });
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: SPECIALISTS_CONFIG.maxRestartRetries,
    });

    await sweepSpecialistTasks();

    expect(routeResult).toHaveBeenCalledOnce();
    const arg = vi.mocked(routeResult).mock.calls[0][0];
    expect(arg.id).toBe(parent.id);
    expect(arg.status).toBe('failed');
    expect(arg.failure_kind).toBe('timeout');
  });
});

// ── SpecialistTaskTimedOut — pending child cancellation ───────────────────────

describe('SpecialistTaskTimedOut rule — child subtree cancellation', () => {
  it('cancels pending child when global timeout fires on an awaiting_sub_task parent', async () => {
    const globalOverdueMs = SPECIALISTS_CONFIG.maxTaskDurationMs + 1000;
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: 1000 });
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      dispatchedAgo: globalOverdueMs,
      pendingSubTaskId: child.id,
    });

    await sweepSpecialistTasks();

    const updatedParent = getTask(parent.id)!;
    expect(updatedParent.status).toBe('failed');
    expect(updatedParent.failure_kind).toBe('timeout');
    expect(updatedParent.pending_sub_task_id).toBeNull();

    // ChildSubtreeCancelledOnSubTaskAwaitExhausted fires for timeout + pending child
    expect(getTask(child.id)!.status).toBe('failed');
  });

  it('does not attempt child cancellation when there is no pending sub-task', async () => {
    const globalOverdueMs = SPECIALISTS_CONFIG.maxTaskDurationMs + 1000;
    const parent = makeSpecialistTask({
      status: 'running',
      dispatchedAgo: globalOverdueMs,
    });

    await sweepSpecialistTasks();

    expect(getTask(parent.id)!.status).toBe('failed');
    expect(getTask(parent.id)!.failure_kind).toBe('timeout');
  });
});

// ── Crash detection scope ─────────────────────────────────────────────────────

describe('crash detection — awaiting_sub_task excluded', () => {
  it('does not crash-detect an awaiting_sub_task parent whose container is stopped', async () => {
    // The parent container is intentionally stopped (it exited after dispatch_sub_task).
    // Step 4 (crash detection) must not fire for this state.
    const child = makeSpecialistTask({ status: 'running', dispatchedAgo: 1000 });
    const parent = makeSpecialistTask({
      status: 'awaiting_sub_task',
      pendingSubTaskId: child.id,
      restartAttemptCount: 0,
    });

    await sweepSpecialistTasks();

    // isContainerRunning returns false (container stopped) but neither
    // crash-restart nor exhaustion should fire — child is not yet overdue
    expect(getTask(parent.id)!.status).toBe('awaiting_sub_task');
    expect(getTask(parent.id)!.restart_attempt_count).toBe(0);
  });
});

describe('crash detection — queued tasks excluded', () => {
  it('does not crash-detect a queued task whose container is not yet running', async () => {
    // A queued task with no container is legitimately waiting for a concurrency
    // slot (wakeOrQueue enqueued it) or was just dispatched before the container
    // started. Treating it as a crash would burn restart_attempt_count while the
    // task is merely waiting, exhausting retries before any container runs.
    const task = makeSpecialistTask({ status: 'queued' });

    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('queued');
    expect(getTask(task.id)!.restart_attempt_count).toBe(0);
  });

  it('does not crash-detect a queued task even after multiple sweep ticks', async () => {
    // Verify the fix holds across repeated ticks (simulating the scenario
    // where the concurrency cap stays full across several sweep intervals).
    const task = makeSpecialistTask({ status: 'queued' });

    await sweepSpecialistTasks();
    await sweepSpecialistTasks();
    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('queued');
    expect(getTask(task.id)!.restart_attempt_count).toBe(0);
  });

  it('advances a queued task to running when its container starts', async () => {
    // Once a slot opens and the container starts, step 3 advances the task.
    const { isContainerRunning } = await import('../../container-runner.js');
    vi.mocked(isContainerRunning).mockReturnValueOnce(true);

    const task = makeSpecialistTask({ status: 'queued' });

    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('running');
  });

  it('still crash-detects a running task whose container stopped', async () => {
    // Regression guard: removing queued from crash detection must not also
    // remove running.
    const task = makeSpecialistTask({ status: 'running', restartAttemptCount: 0 });

    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('awaiting_restart');
    expect(getTask(task.id)!.restart_attempt_count).toBe(1);
  });
});

// A container that dies ~800ms into boot is never observed dead: the host sweep
// runs sweepSession() (which SPAWNS the container) before sweepSpecialistTasks(),
// so isContainerRunning is true in the very tick that started it. queued gets
// advanced to running by path 3, running never trips path 4, and the task lives
// until the 4h global timeout. Real incident: 241 respawns over 4 hours with
// restart_attempt_count still 0 and the reason (EROFS) unread in the stderr tail.
describe('crash detection — container that cannot start', () => {
  // These cases drive isContainerRunning/getBootCrashState directly, and
  // mockReturnValue persists across tests — reset both to the healthy default
  // so each case starts from the same ground state.
  beforeEach(async () => {
    const { getBootCrashState, isContainerRunning } = await import('../../container-runner.js');
    vi.mocked(isContainerRunning).mockReturnValue(false);
    vi.mocked(getBootCrashState).mockReturnValue({ count: 0, stderrTail: [] });
  });

  it('fails a queued task once its container has boot-crashed repeatedly', async () => {
    const { getBootCrashState } = await import('../../container-runner.js');
    vi.mocked(getBootCrashState).mockReturnValue({
      count: 3,
      stderrTail: ['[agent-runner] Fatal error: EROFS: read-only file system'],
    });

    const task = makeSpecialistTask({ status: 'queued' });

    await sweepSpecialistTasks();

    const fresh = getTask(task.id)!;
    expect(fresh.status).toBe('failed');
    expect(fresh.failure_kind).toBe('host_restart');
    // The reason must reach the requester, not just the host log.
    expect(fresh.failure_detail).toContain('EROFS');
    expect(routeResult).toHaveBeenCalled();
  });

  // Regression guard for the exact defect a live run exposed: an earlier version
  // of this fix required !containerAlive, which can never hold here because the
  // sweep spawns the container immediately before sampling it.
  it('fails despite the container appearing alive at sample time', async () => {
    const { getBootCrashState, isContainerRunning } = await import('../../container-runner.js');
    vi.mocked(isContainerRunning).mockReturnValue(true);
    vi.mocked(getBootCrashState).mockReturnValue({ count: 3, stderrTail: ['Fatal error: boom'] });

    const task = makeSpecialistTask({ status: 'queued' });

    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('failed');
  });

  // The same race strands `running` tasks: path 4 needs !containerAlive too.
  it('fails a running task whose container is crash-looping', async () => {
    const { getBootCrashState, isContainerRunning } = await import('../../container-runner.js');
    vi.mocked(isContainerRunning).mockReturnValue(true);
    vi.mocked(getBootCrashState).mockReturnValue({ count: 4, stderrTail: ['Fatal error: boom'] });

    const task = makeSpecialistTask({ status: 'running' });

    await sweepSpecialistTasks();

    const fresh = getTask(task.id)!;
    expect(fresh.status).toBe('failed');
    expect(fresh.failure_kind).toBe('host_restart');
  });

  // awaiting_sub_task's container is legitimately stopped; path 2 owns it.
  it('leaves an awaiting_sub_task task to the sub-task await path', async () => {
    const { getBootCrashState } = await import('../../container-runner.js');
    vi.mocked(getBootCrashState).mockReturnValue({ count: 5, stderrTail: ['boom'] });

    const task = makeSpecialistTask({ status: 'awaiting_sub_task' });

    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('awaiting_sub_task');
  });

  it('leaves a queued task alone while it is merely waiting for a slot', async () => {
    // Same state, no recorded crashes — this is the case the exclusion exists
    // for, and it must keep working or queued tasks burn their retries waiting.
    const { getBootCrashState } = await import('../../container-runner.js');
    vi.mocked(getBootCrashState).mockReturnValue({ count: 0, stderrTail: [] });

    const task = makeSpecialistTask({ status: 'queued' });

    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('queued');
    expect(routeResult).not.toHaveBeenCalled();
  });

  it('does not fail below the threshold', async () => {
    // One or two fast exits can be transient (image pull, host hiccup); only a
    // sustained loop is conclusive.
    const { getBootCrashState } = await import('../../container-runner.js');
    vi.mocked(getBootCrashState).mockReturnValue({ count: 2, stderrTail: ['boom'] });

    const task = makeSpecialistTask({ status: 'queued' });

    await sweepSpecialistTasks();

    expect(getTask(task.id)!.status).toBe('queued');
  });
});
