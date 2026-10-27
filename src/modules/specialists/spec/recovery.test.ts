/**
 * Propagated from specs/specialists.allium — recovery and deletion:
 * SpecialistContainerCrashed, ChildSubtreeCancelledOnParentCrash,
 * SubtreeCancellationApplied, SpecialistRestartExhausted,
 * ChildSubtreeCancelledOnRestartExhausted, SubTaskAwaitTimedOut,
 * SubTaskAwaitExhausted, ChildSubtreeCancelledOnSubTaskAwaitExhausted,
 * SpecialistTasksFailedOnGroupDeleted.
 *
 * The spec observes a crash as the session's processing_state moving to
 * stuck; the code detects it by sampling container liveness in the sweep
 * (recovery.ts path 4). These tests drive the sweep's crash path: a task in
 * `running` whose container is not alive. Time is controlled through task
 * timestamps (dispatched_at), never by sleeping.
 *
 * Real code throughout — sweepSpecialistTasks, cancelSubtree, routeResult,
 * failTasksOfDeletedGroup via announceGroupDeletion — against a migrated test
 * DB. Only process/container boundaries are mocked.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  alive: new Set<string>(),
  bootCrashes: new Map<string, { count: number; stderrTail: string[] }>(),
}));

vi.mock('../../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../container-runner.js')>()),
  isContainerRunning: vi.fn((sessionId: string) => runtime.alive.has(sessionId)),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));
vi.mock('../../boot-crash/index.js', () => ({
  getBootCrashState: vi.fn((sessionId: string) => runtime.bootCrashes.get(sessionId) ?? { count: 0, stderrTail: [] }),
  clearBootCrashState: vi.fn(),
  registerBootCrashExemption: vi.fn(),
}));
vi.mock('../../../session-manager.js', () => ({
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(async () => {}),
  // No mailbox: a running task with no container is not "owed a wake".
  withExistingMailboxSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));
vi.mock('../postmortem.js', () => ({ buildPostMortem: vi.fn(() => null) }));
vi.mock('../invocation.js', () => ({
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
  reclaimTransferStaging: vi.fn(),
}));

import { wakeContainer } from '../../../container-runner.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createSession, getSession } from '../../../db/sessions.js';
import { announceGroupDeletion } from '../../../group-delete.js';
import { writeSessionMessage } from '../../../session-manager.js';
import { SPECIALISTS_CONFIG } from '../config.js';
import { createSpecialist, createTask, getTask } from '../db.js';
import '../group-delete.js'; // registers the specialists deletion hook
import { cancelSubtree, sweepSpecialistTasks } from '../recovery.js';
import type { SpecialistTask } from '../types.js';
import { covered, divergence, obligation } from './harness.js';

const MAX = SPECIALISTS_CONFIG.maxRestartRetries;
const AWAIT_OVERDUE = SPECIALISTS_CONFIG.maxSubTaskAwaitMs + 60_000;
const TASK_OVERDUE = SPECIALISTS_CONFIG.maxTaskDurationMs + 60_000;
const CANCELLED = 'cancelled: an ancestor specialist task ended';

const nowIso = () => new Date().toISOString();
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const sessOf = (taskId: string) => `sess-${taskId}`;

async function group(id: string, specialist: boolean): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: nowIso() });
  if (specialist) {
    await createSpecialist({
      agent_group_id: id,
      is_memory_provider: 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: nowIso(),
    });
  }
}

async function session(id: string, agentGroup: string, thread: string | null): Promise<void> {
  await createSession({
    id,
    agent_group_id: agentGroup,
    messaging_group_id: null,
    thread_id: thread,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: nowIso(),
    created_at: nowIso(),
  });
}

/** A task and its per-task session (thread = task id). */
async function task(opts: {
  id: string;
  status: SpecialistTask['status'];
  group?: string;
  requester?: { group: string; session: string } | { task: string };
  dispatchedAgo?: number;
  restarts?: number;
}): Promise<void> {
  const g = opts.group ?? 'ag-spec';
  const req = opts.requester ?? { group: 'ag-main', session: 'sess-main' };
  await session(sessOf(opts.id), g, opts.id);
  const terminal = opts.status === 'completed' || opts.status === 'failed';
  await createTask({
    id: opts.id,
    specialist_group_id: g,
    prompt: 'do work',
    requester_group_id: 'group' in req ? req.group : null,
    requester_task_id: 'task' in req ? req.task : null,
    requester_session_id: 'group' in req ? req.session : sessOf(req.task),
    depth: 'group' in req ? 0 : 1,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: opts.status,
    dispatched_at: isoAgo(opts.dispatchedAgo ?? 1000),
    restart_attempt_count: opts.restarts ?? 0,
    closed_at: terminal ? nowIso() : null,
    result: opts.status === 'completed' ? 'done' : null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  });
}

/** Setup: the parent holds child as its pending sub-task. */
const link = (parent: string, child: string) =>
  getDb().run('UPDATE specialist_tasks SET pending_sub_task_id = ? WHERE id = ?', child, parent);

const get = async (id: string) => (await getTask(id))!;

const sentTo = (sessionId: string): string[] =>
  vi
    .mocked(writeSessionMessage)
    .mock.calls.filter(([, s]) => s === sessionId)
    .map(([, , m]) => JSON.parse((m as { content: string }).content).text as string);

const wokenSessions = (): string[] => vi.mocked(wakeContainer).mock.calls.map(([s]) => (s as { id: string }).id);

beforeEach(async () => {
  vi.clearAllMocks();
  runtime.alive.clear();
  runtime.bootCrashes.clear();
  await runMigrations(await initTestDb());
  await group('ag-main', false);
  await group('ag-spec', true);
  await group('ag-gone', true);
  await group('ag-kept', true);
  await session('sess-main', 'ag-main', null);
});

afterEach(async () => {
  await closeDb();
});

// ── SpecialistContainerCrashed ────────────────────────────────────────────────

covered(
  'rule-success.SpecialistContainerCrashed',
  'src/modules/specialists/recovery.test.ts',
  'still crash-detects a running task whose container stopped',
);

obligation('rule-failure.SpecialistContainerCrashed.1', async () => {
  // A specialist session whose thread names no task: its container is dead,
  // but there is no task to move to awaiting_restart.
  await session('sess-orphan', 'ag-spec', 'no-such-task');

  await sweepSpecialistTasks();

  const rows = await getDb().all<{ id: string }>('SELECT id FROM specialist_tasks');
  expect(rows).toEqual([]);
  expect((await getSession('sess-orphan'))!.status).toBe('active');
  expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
});

covered(
  'rule-failure.SpecialistContainerCrashed.2',
  'src/modules/specialists/recovery.test.ts',
  'does not crash-detect a queued task whose container is not yet running',
);

obligation('rule-failure.SpecialistContainerCrashed.3', async () => {
  // Retries exhausted: a crash does not restart the task.
  await task({ id: 't-crash', status: 'running', restarts: MAX });

  await sweepSpecialistTasks();

  const t = await get('t-crash');
  expect(t.status).not.toBe('awaiting_restart');
  expect(t.status).toBe('failed');
  expect(sentTo(sessOf('t-crash'))).toEqual([]); // no restart prompt written
});

// ── ChildSubtreeCancelledOnParentCrash ────────────────────────────────────────

covered(
  'rule-success.ChildSubtreeCancelledOnParentCrash',
  'src/modules/specialists/recovery.test.ts',
  'cancels the pending child subtree when transitioning to awaiting_restart',
);

obligation('rule-failure.ChildSubtreeCancelledOnParentCrash.1', async () => {
  // The crashing task holds no pending sub-task. A live task it once requested
  // (reachable only through requester_task, not pending_sub_task) is not
  // cancelled: cancellation follows the pending_sub_task chain only.
  await task({ id: 't-parent', status: 'running', restarts: 0 });
  await task({ id: 't-other', status: 'running', requester: { task: 't-parent' } });
  runtime.alive.add(sessOf('t-other'));

  await sweepSpecialistTasks();

  expect((await get('t-parent')).status).toBe('awaiting_restart');
  const other = await get('t-other');
  expect(other.status).toBe('running');
  expect(other.failure_detail).toBeNull();
  expect((await getSession(sessOf('t-other')))!.status).toBe('active');
});

// ── SubtreeCancellationApplied ────────────────────────────────────────────────

obligation('rule-success.SubtreeCancellationApplied', async () => {
  await task({ id: 't-c1', status: 'awaiting_sub_task' });
  await task({ id: 't-c2', status: 'awaiting_sub_task', requester: { task: 't-c1' } });
  await task({ id: 't-c3', status: 'running', requester: { task: 't-c2' } });
  await link('t-c1', 't-c2');
  await link('t-c2', 't-c3');
  const before = Date.now();

  await cancelSubtree('t-c1');

  for (const id of ['t-c1', 't-c2', 't-c3']) {
    const t = await get(id);
    expect(t.status, id).toBe('failed');
    expect(t.failure_kind, id).toBe('execution_error');
    expect(t.failure_detail, id).toBe(CANCELLED);
    expect(Date.parse(t.closed_at!), id).toBeGreaterThanOrEqual(before - 1000);
    // Terminal: its session is closed (container stopped).
    expect((await getSession(sessOf(id)))!.status, id).toBe('closed');
  }
});

obligation('rule-failure.SubtreeCancellationApplied.1', async () => {
  // The cancelled task is already terminal: it is left as it is, and the
  // cancellation does not walk on through it.
  await task({ id: 't-done', status: 'completed' });
  await task({ id: 't-below', status: 'running', requester: { task: 't-done' } });
  await link('t-done', 't-below');
  const doneBefore = await get('t-done');

  await cancelSubtree('t-done');

  const done = await get('t-done');
  expect(done.status).toBe('completed');
  expect(done.failure_kind).toBeNull();
  expect(done.closed_at).toBe(doneBefore.closed_at);
  const below = await get('t-below');
  expect(below.status).toBe('running');
  expect(below.failure_detail).toBeNull();
});

// ── SpecialistRestartExhausted ────────────────────────────────────────────────

obligation('rule-success.SpecialistRestartExhausted', async () => {
  await task({ id: 't-ex', status: 'running', restarts: MAX });
  const before = Date.now();

  await sweepSpecialistTasks();

  const t = await get('t-ex');
  expect(t.status).toBe('failed');
  expect(t.failure_kind).toBe('host_restart');
  expect(Date.parse(t.closed_at!)).toBeGreaterThanOrEqual(before - 1000);
  // SpecialistFailureRoutedToRequester: the main requester is told.
  expect(sentTo('sess-main').join('\n')).toContain('host_restart');
  expect(t.failure_detail).toBe('specialist container failed and maximum restart retries were exhausted');
});

obligation('rule-failure.SpecialistRestartExhausted.1', async () => {
  // No task behind the stuck session: nothing fails, nothing is routed.
  await session('sess-orphan', 'ag-spec', 'missing-task');

  await sweepSpecialistTasks();

  const rows = await getDb().all<{ id: string }>('SELECT id FROM specialist_tasks');
  expect(rows).toEqual([]);
  expect(sentTo('sess-main')).toEqual([]);
  expect((await getSession('sess-orphan'))!.status).toBe('active');
});

obligation('rule-failure.SpecialistRestartExhausted.2', async () => {
  // Not running: an awaiting_restart task whose retries are spent and whose
  // container is down is re-woken, not failed.
  await task({ id: 't-ar', status: 'awaiting_restart', restarts: MAX });

  await sweepSpecialistTasks();

  const t = await get('t-ar');
  expect(t.status).toBe('awaiting_restart');
  expect(t.failure_kind).toBeNull();
  expect(t.restart_attempt_count).toBe(MAX);
  expect(wokenSessions()).toContain(sessOf('t-ar'));
});

obligation('rule-failure.SpecialistRestartExhausted.3', async () => {
  // Retries remain: the crash restarts the task rather than failing it.
  await task({ id: 't-r', status: 'running', restarts: MAX - 1 });

  await sweepSpecialistTasks();

  const t = await get('t-r');
  expect(t.status).toBe('awaiting_restart');
  expect(t.failure_kind).toBeNull();
  expect(t.closed_at).toBeNull();
  expect(sentTo('sess-main')).toEqual([]);
});

// ── ChildSubtreeCancelledOnRestartExhausted ───────────────────────────────────

obligation('rule-success.ChildSubtreeCancelledOnRestartExhausted', async () => {
  // A running task still holding a live pending sub-task exhausts its retries.
  await task({ id: 't-par', status: 'running', restarts: MAX });
  await task({ id: 't-child', status: 'awaiting_sub_task', requester: { task: 't-par' } });
  await task({ id: 't-gc', status: 'running', requester: { task: 't-child' } });
  await link('t-par', 't-child');
  await link('t-child', 't-gc');
  runtime.alive.add(sessOf('t-gc'));

  await sweepSpecialistTasks();

  expect((await get('t-par')).failure_kind).toBe('host_restart');
  for (const id of ['t-child', 't-gc']) {
    const t = await get(id);
    expect(t.status, id).toBe('failed');
    expect(t.failure_kind, id).toBe('execution_error');
    expect(t.failure_detail, id).toBe(CANCELLED);
  }
});

divergence(
  'rule-failure.ChildSubtreeCancelledOnRestartExhausted.1',
  'a boot_failure (recovery.ts:255, path 2b) also cancels the pending sub-task; the spec has no cancellation for boot_failure (SpecialistBootFailed assumes none is pending). Reachable only from a hand-built running task with a live pending child',
  async () => {
    // A failed transition with a pending sub-task but kind = boot_failure.
    await task({ id: 't-boot', status: 'running' });
    await task({ id: 't-kid', status: 'running', requester: { task: 't-boot' } });
    await link('t-boot', 't-kid');
    runtime.alive.add(sessOf('t-kid'));
    runtime.bootCrashes.set(sessOf('t-boot'), { count: 3, stderrTail: ['boom'] });

    await sweepSpecialistTasks();

    expect((await get('t-boot')).failure_kind).toBe('boot_failure');
    expect((await get('t-kid')).status).toBe('running');
  },
);

obligation('rule-failure.ChildSubtreeCancelledOnRestartExhausted.2', async () => {
  // Fails with host_restart but holds no pending sub-task: a live task it
  // requested is not reached.
  await task({ id: 't-par', status: 'running', restarts: MAX });
  await task({ id: 't-other', status: 'running', requester: { task: 't-par' } });
  runtime.alive.add(sessOf('t-other'));

  await sweepSpecialistTasks();

  expect((await get('t-par')).failure_kind).toBe('host_restart');
  const other = await get('t-other');
  expect(other.status).toBe('running');
  expect(other.failure_detail).toBeNull();
});

// ── SubTaskAwaitTimedOut ──────────────────────────────────────────────────────

covered(
  'rule-success.SubTaskAwaitTimedOut',
  'src/modules/specialists/recovery.test.ts',
  'transitions awaiting_sub_task parent to awaiting_restart when child is overdue and retries remain',
);

obligation('rule-failure.SubTaskAwaitTimedOut.1', async () => {
  // Overdue, but retries are spent: the parent is not restarted.
  await task({ id: 't-par', status: 'awaiting_sub_task', restarts: MAX });
  await task({ id: 't-child', status: 'running', dispatchedAgo: AWAIT_OVERDUE, requester: { task: 't-par' } });
  await link('t-par', 't-child');
  runtime.alive.add(sessOf('t-child'));

  await sweepSpecialistTasks();

  const t = await get('t-par');
  expect(t.status).not.toBe('awaiting_restart');
  expect(t.restart_attempt_count).toBe(MAX);
});

// ── SubTaskAwaitExhausted ─────────────────────────────────────────────────────

obligation('rule-success.SubTaskAwaitExhausted', async () => {
  await task({ id: 't-par', status: 'awaiting_sub_task', restarts: MAX });
  await task({ id: 't-child', status: 'running', dispatchedAgo: AWAIT_OVERDUE, requester: { task: 't-par' } });
  await link('t-par', 't-child');
  runtime.alive.add(sessOf('t-child'));
  const before = Date.now();

  await sweepSpecialistTasks();

  const t = await get('t-par');
  expect(t.status).toBe('failed');
  expect(t.failure_kind).toBe('timeout');
  expect(t.failure_detail).toBe('sub-task did not complete within the await window after exhausting restart retries');
  expect(Date.parse(t.closed_at!)).toBeGreaterThanOrEqual(before - 1000);
  expect(sentTo('sess-main').join('\n')).toContain('timeout');
});

obligation('rule-failure.SubTaskAwaitExhausted.1', async () => {
  // Overdue with retries left: restarted, not failed.
  await task({ id: 't-par', status: 'awaiting_sub_task', restarts: MAX - 1 });
  await task({ id: 't-child', status: 'running', dispatchedAgo: AWAIT_OVERDUE, requester: { task: 't-par' } });
  await link('t-par', 't-child');
  runtime.alive.add(sessOf('t-child'));

  await sweepSpecialistTasks();

  const t = await get('t-par');
  expect(t.status).toBe('awaiting_restart');
  expect(t.failure_kind).toBeNull();
  expect(t.closed_at).toBeNull();
  expect(sentTo('sess-main')).toEqual([]);
});

// ── ChildSubtreeCancelledOnSubTaskAwaitExhausted ──────────────────────────────

covered(
  'rule-success.ChildSubtreeCancelledOnSubTaskAwaitExhausted',
  'src/modules/specialists/recovery.test.ts',
  'cancels the pending child subtree on exhaustion',
);

divergence(
  'rule-failure.ChildSubtreeCancelledOnSubTaskAwaitExhausted.1',
  'a boot_failure (recovery.ts:255, path 2b) also cancels the pending sub-task; the spec has no cancellation for boot_failure (SpecialistBootFailed assumes none is pending). Reachable only from a hand-built task with a live pending child',
  async () => {
    // A failed transition with a pending sub-task but kind != timeout.
    await task({ id: 't-boot', status: 'awaiting_restart', restarts: 1 });
    await task({ id: 't-kid', status: 'running', requester: { task: 't-boot' } });
    await link('t-boot', 't-kid');
    runtime.alive.add(sessOf('t-kid'));
    runtime.bootCrashes.set(sessOf('t-boot'), { count: 3, stderrTail: ['boom'] });

    await sweepSpecialistTasks();

    expect((await get('t-boot')).failure_kind).toBe('boot_failure');
    expect((await get('t-kid')).status).toBe('running');
  },
);

obligation('rule-failure.ChildSubtreeCancelledOnSubTaskAwaitExhausted.2', async () => {
  // Fails with kind = timeout (overall duration) but holds no pending
  // sub-task: a live task it requested is not reached.
  await task({ id: 't-par', status: 'running', dispatchedAgo: TASK_OVERDUE });
  await task({ id: 't-other', status: 'running', requester: { task: 't-par' } });
  runtime.alive.add(sessOf('t-par'));
  runtime.alive.add(sessOf('t-other'));

  await sweepSpecialistTasks();

  expect((await get('t-par')).failure_kind).toBe('timeout');
  const other = await get('t-other');
  expect(other.status).toBe('running');
  expect(other.failure_detail).toBeNull();
});

// ── SpecialistTasksFailedOnGroupDeleted ───────────────────────────────────────

obligation('rule-success.SpecialistTasksFailedOnGroupDeleted', async () => {
  // ag-gone is a specialist (runs t-gone-child, t-gone-par) and also requested
  // a root task itself (t-root-of-gone, from its session sess-gone).
  await session('sess-gone', 'ag-gone', null);

  // 1. A deleted-group sub-task with a surviving parent waiting on it.
  await task({ id: 't-kept-par', status: 'awaiting_sub_task', group: 'ag-kept' });
  await task({ id: 't-gone-child', status: 'running', group: 'ag-gone', requester: { task: 't-kept-par' } });
  await link('t-kept-par', 't-gone-child');

  // 2. A deleted-group root task with a surviving child chain below it.
  await task({ id: 't-gone-par', status: 'awaiting_sub_task', group: 'ag-gone' });
  await task({ id: 't-kept-child', status: 'awaiting_sub_task', group: 'ag-kept', requester: { task: 't-gone-par' } });
  await task({ id: 't-kept-gc', status: 'running', group: 'ag-kept', requester: { task: 't-kept-child' } });
  await link('t-gone-par', 't-kept-child');
  await link('t-kept-child', 't-kept-gc');

  // 3. A root task the deleted group requested, run by a surviving specialist.
  await task({
    id: 't-root-of-gone',
    status: 'queued',
    group: 'ag-kept',
    requester: { group: 'ag-gone', session: 'sess-gone' },
  });

  // Untouched: a finished task of the group, and live work unrelated to it.
  await task({ id: 't-gone-done', status: 'completed', group: 'ag-gone' });
  await task({ id: 't-bystander', status: 'running', group: 'ag-kept' });

  const before = Date.now();
  await announceGroupDeletion('ag-gone');

  for (const id of ['t-gone-child', 't-gone-par', 't-root-of-gone']) {
    const t = await get(id);
    expect(t.status, id).toBe('failed');
    expect(t.failure_kind, id).toBe('group_deleted');
    expect(t.failure_detail, id).toBe('specialist task ended: its agent group was deleted');
    expect(Date.parse(t.closed_at!), id).toBeGreaterThanOrEqual(before - 1000);
    expect((await getSession(sessOf(id)))!.status, id).toBe('closed');
  }
  // Requester links are never cleared (ExactlyOneRequester keeps holding).
  expect((await get('t-gone-child')).requester_task_id).toBe('t-kept-par');
  expect((await get('t-root-of-gone')).requester_group_id).toBe('ag-gone');

  // The surviving parent is told at once and resumes.
  expect((await get('t-kept-par')).status).toBe('running');
  expect(sentTo(sessOf('t-kept-par')).join('\n')).toContain('group_deleted');
  // The surviving main requester of the deleted root task is told too.
  expect(sentTo('sess-main').join('\n')).toContain('group_deleted');

  // The surviving chain below the deleted task is cancelled.
  for (const id of ['t-kept-child', 't-kept-gc']) {
    const t = await get(id);
    expect(t.status, id).toBe('failed');
    expect(t.failure_kind, id).toBe('execution_error');
    expect(t.failure_detail, id).toBe(CANCELLED);
  }

  // A requester that is itself being deleted is neither messaged nor woken.
  expect(sentTo('sess-gone')).toEqual([]);
  expect(wokenSessions()).not.toContain('sess-gone');

  // Finished and unrelated tasks are left alone.
  expect((await get('t-gone-done')).status).toBe('completed');
  expect((await get('t-bystander')).status).toBe('running');
});
