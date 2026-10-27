/**
 * Structure obligations from specs/specialists.allium: the surface, enums,
 * value types, entity fields / optionals / when-presence / relationships,
 * derived values, config defaults and invariants.
 *
 * Everything runs against the real schema (migrations) and the real module
 * code — dispatch handlers, delivery, routing, invocations, the recovery
 * sweep, group deletion. The process boundary is mocked: container spawning,
 * the session mailbox, wake requests, the null channel and the boot-crash
 * counter. Raw SQL is used only to set up pre-states and to read results.
 *
 * Most invariants are checked over `busyWorld`, which drives a broad mix of
 * rules (root and sub-task dispatch, memory-provider lookup, the three chain
 * rejections, text and file delivery, commit to memory, ipc-in placement,
 * timeout with subtree cancellation, crash restart and exhaustion, boot
 * failure, group deletion) and calls the check after every step.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, vi } from 'vitest';

const env = vi.hoisted(() => ({
  root: `/tmp/nanoclaw-spec-structure-${process.pid}`,
  running: new Set<string>(),
  boot: new Map<string, { count: number; stderrTail: string[] }>(),
}));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: `${env.root}/data`,
  GROUPS_DIR: `${env.root}/groups`,
}));
vi.mock('../../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../container-runner.js')>()),
  wakeContainer: vi.fn(async () => true),
  killContainer: vi.fn(),
  isContainerRunning: (sessionId: string) => env.running.has(sessionId),
}));
vi.mock('../../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session-manager.js')>()),
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(async () => {}),
  withExistingMailboxSession: vi.fn(async () => undefined),
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../../channels/null-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../channels/null-channel.js')>()),
  getNullMessagingGroupId: async () => null,
}));
vi.mock('../../boot-crash/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../boot-crash/index.js')>()),
  getBootCrashState: (sessionId: string) => env.boot.get(sessionId) ?? { count: 0, stderrTail: [] },
  clearBootCrashState: (sessionId: string) => {
    env.boot.delete(sessionId);
  },
}));

import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createSession, getSession } from '../../../db/sessions.js';
import { getDeliveryAction } from '../../../delivery.js';
import type { Session } from '../../../types.js';
import { SPECIALISTS_CONFIG } from '../config.js';
import {
  createSpecialist,
  createTask,
  getLiveTaskForSession,
  getLiveTasksWithSessions,
  getTask,
  setMainGroup,
} from '../db.js';
import { handleDeliverSpecialistResult } from '../delivery.js';
import { handleDispatchSpecialist, handleDispatchSubTask } from '../dispatch.js';
import { deleteSpecialistRowsForGroup, failTasksOfDeletedGroup } from '../group-delete.js';
import { buildInvocationForSession, getActiveInvocation } from '../invocation.js';
import { sweepSpecialistTasks } from '../recovery.js';
import type { ContainerTransfer, Invocation, SpecialistTask, TransferFile } from '../types.js';
import '../index.js';
import { covered, divergence, obligation } from './harness.js';

// ── Spec enums (specs/specialists.allium, Enumerations) ──────────────────────

const TASK_STATUSES = ['queued', 'running', 'awaiting_sub_task', 'awaiting_restart', 'completed', 'failed'];
const TERMINAL = new Set(['completed', 'failed']);
const FAILURE_KINDS = [
  'depth_exceeded',
  'count_exceeded',
  'same_type_limit_exceeded',
  'timeout',
  'execution_error',
  'host_restart',
  'boot_failure',
  'group_deleted',
];
const MOUNT_STATUSES = ['active', 'cleared'];
const TRANSFER_STATUSES = ['pending', 'in_transit', 'committed', 'expired'];
const TRANSFER_FILE_STATUSES = ['owned', 'placed', 'expired'];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const now = (): string => new Date().toISOString();
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function group(id: string, kind: 'plain' | 'specialist' | 'memory' = 'plain'): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  if (kind === 'plain') return;
  await createSpecialist({
    agent_group_id: id,
    is_memory_provider: kind === 'memory' ? 1 : 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
}

async function mkSession(id: string, agentGroupId: string, threadId: string | null): Promise<Session> {
  await createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });
  return (await getSession(id))!;
}

const mainSession = async (): Promise<Session> => (await getSession('sess-main'))!;

/** A task's own per-task session (thread_id = task id), whatever its status. */
async function sessionOf(t: { id: string; specialist_group_id: string }): Promise<Session | undefined> {
  return getDb().get<Session>(
    'SELECT * FROM sessions WHERE agent_group_id = ? AND thread_id = ?',
    t.specialist_group_id,
    t.id,
  );
}

async function newestTaskFrom(requesterSessionId: string): Promise<SpecialistTask> {
  return (await getDb().get<SpecialistTask>(
    'SELECT * FROM specialist_tasks WHERE requester_session_id = ? ORDER BY rowid DESC LIMIT 1',
    requesterSessionId,
  ))!;
}

const allTasks = (): Promise<SpecialistTask[]> => getDb().all<SpecialistTask>('SELECT * FROM specialist_tasks');
const allTransfers = (): Promise<ContainerTransfer[]> =>
  getDb().all<ContainerTransfer>('SELECT * FROM container_transfers');
const allFiles = (): Promise<TransferFile[]> => getDb().all<TransferFile>('SELECT * FROM transfer_files');
const fresh = async (t: { id: string }): Promise<SpecialistTask> => (await getTask(t.id))!;

/** The main agent calls dispatch_specialist. */
async function dispatchRoot(target: string): Promise<SpecialistTask> {
  await handleDispatchSpecialist({ specialist_group_id: target, prompt: 'root work' }, await mainSession());
  return newestTaskFrom('sess-main');
}

/** The task's own container calls dispatch_sub_task; returns the task row it created, if any. */
async function dispatchSub(parent: SpecialistTask, target: string): Promise<SpecialistTask | undefined> {
  const s = (await sessionOf(parent))!;
  const before = (await allTasks()).length;
  await handleDispatchSubTask({ specialist_group_id: target, prompt: 'sub work' }, s);
  if ((await allTasks()).length === before) return undefined;
  return newestTaskFrom(s.id);
}

/** The task's own container calls deliver_specialist_result, optionally with files written to its ipc-out. */
async function deliver(
  t: SpecialistTask,
  text: string,
  files?: Record<string, string>,
  commit?: boolean,
): Promise<void> {
  const s = (await sessionOf(t))!;
  let filePaths: string[] | undefined;
  if (files) {
    await buildInvocationForSession(s);
    const inv = (await getActiveInvocation(s.id))!;
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(inv.ipc_out_host_path, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    filePaths = Object.keys(files).map((rel) => `${SPECIALISTS_CONFIG.ipcOutContainerPath}/${rel}`);
  }
  await handleDeliverSpecialistResult({ result_text: text, file_paths: filePaths, commit_to_memory: commit }, s);
}

/** Setup only: a task row in a given state, with its per-task session unless told otherwise. */
async function seedTask(
  over: Partial<SpecialistTask> & { id: string; specialist_group_id: string },
  withSession = true,
): Promise<SpecialistTask> {
  const t: SpecialistTask = {
    prompt: 'seeded',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
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
    ...over,
  };
  if (withSession) await mkSession(`sess-${t.id}`, t.specialist_group_id, t.id);
  await createTask(t);
  return t;
}

/** Setup only: a sub-task of `parent` (requester links and ancestry consistent with the spec). */
async function seedSub(
  parent: SpecialistTask,
  over: Partial<SpecialistTask> & { id: string; specialist_group_id: string },
  withSession = true,
): Promise<SpecialistTask> {
  const parentSession = (await sessionOf(parent))!;
  return seedTask(
    {
      requester_group_id: null,
      requester_task_id: parent.id,
      requester_session_id: parentSession.id,
      depth: parent.depth + 1,
      chain_delegation_count: parent.chain_delegation_count + 1,
      ancestor_group_ids: JSON.stringify([...JSON.parse(parent.ancestor_group_ids), parent.specialist_group_id]),
      ...over,
    },
    withSession,
  );
}

type Check = (step: string) => Promise<void>;

/**
 * A broad run of the module's rules, calling `check` after every step. Every
 * state change here is made by module code; the seeded rows are pre-states.
 */
async function busyWorld(check: Check = async () => {}): Promise<Record<string, SpecialistTask>> {
  await check('initial');

  // Root dispatch, sub-task dispatch, the child seen running, its text result resuming the parent.
  const r1 = await dispatchRoot('ag-a');
  await check('root dispatched');
  const s1 = (await dispatchSub(r1, 'ag-b'))!;
  await check('sub-task dispatched');
  const s1Session = (await sessionOf(s1))!;
  env.running.add(s1Session.id);
  await sweepSpecialistTasks();
  await check('sub-task seen running');
  await deliver(s1, 'sub done');
  env.running.delete(s1Session.id);
  await check('sub-task delivered text');

  // Rejected dispatches: non-specialist targets, a non-main root dispatcher.
  await handleDispatchSpecialist({ specialist_group_id: 'ag-plain', prompt: 'x' }, await mainSession());
  await dispatchSub(r1, 'ag-plain');
  await handleDispatchSpecialist({ specialist_group_id: 'ag-a', prompt: 'x' }, (await getSession('sess-other'))!);
  await check('rejected dispatches');

  // Memory provider lookup; the provider tries to delegate and is refused.
  const m1 = (await dispatchSub(r1, 'ag-mem'))!;
  await check('memory provider dispatched');
  await dispatchSub(m1, 'ag-b');
  await check('memory provider refused delegation');
  await deliver(m1, 'recalled');
  await check('memory provider delivered');

  // Root delivery with files committed to memory.
  await deliver(r1, `See ${SPECIALISTS_CONFIG.ipcOutContainerPath}/report.md`, { 'report.md': 'R' }, true);
  await check('root delivered files to memory');

  // Sub-task delivers files (commit degrades to staging); parent restarts and gets them in ipc-in; parent completes.
  const r2 = await dispatchRoot('ag-a');
  const s2 = (await dispatchSub(r2, 'ag-b'))!;
  await check('second chain dispatched');
  await deliver(s2, `data in ${SPECIALISTS_CONFIG.ipcOutContainerPath}/data.csv`, { 'data.csv': 'a,b' }, true);
  await check('sub-task delivered files');
  await buildInvocationForSession((await sessionOf(r2))!);
  await check('parent invocation started with files placed');
  await deliver(r2, 'final');
  await check('parent completed');

  // A root awaiting a sub-task, past the overall timeout.
  const r3 = await dispatchRoot('ag-a');
  const s3 = (await dispatchSub(r3, 'ag-b'))!;
  await getDb().run('UPDATE specialist_tasks SET dispatched_at = ? WHERE id = ?', ago(5 * 3600_000), r3.id);
  await check('overdue chain set up');

  // The three chain-limit rejections.
  const p4 = await seedSub(r1, {
    id: 'task-p4',
    specialist_group_id: 'ag-a',
    depth: 4,
    ancestor_group_ids: JSON.stringify(['ag-a', 'ag-a', 'ag-a', 'ag-a']),
  });
  await dispatchSub(p4, 'ag-b');
  await check('depth rejection');
  const pc = await seedSub(r1, { id: 'task-pc', specialist_group_id: 'ag-a', chain_delegation_count: 20 });
  await dispatchSub(pc, 'ag-b');
  await check('count rejection');
  const ps = await seedSub(r1, { id: 'task-ps', specialist_group_id: 'ag-a' });
  for (const i of [1, 2, 3]) {
    await seedSub(
      ps,
      { id: `task-ps-${i}`, specialist_group_id: 'ag-b', status: 'completed', closed_at: now(), result: 'ok' },
      false,
    );
  }
  await dispatchSub(ps, 'ag-b');
  await check('same-type rejection');

  // Crash with retries left, crash with retries exhausted, a container that cannot boot.
  const hr = await seedTask({ id: 'task-hr', specialist_group_id: 'ag-a', restart_attempt_count: 2 });
  const cr = await seedTask({ id: 'task-cr', specialist_group_id: 'ag-a' });
  const bf = await seedTask({ id: 'task-bf', specialist_group_id: 'ag-b', status: 'queued' });
  env.boot.set(`sess-${bf.id}`, { count: 3, stderrTail: ['EROFS'] });
  // Group deletion of a group running live work.
  await group('ag-doomed', 'specialist');
  const gd = await seedTask({ id: 'task-gd', specialist_group_id: 'ag-doomed' });
  await failTasksOfDeletedGroup('ag-doomed');
  await check('group deleted');
  // A root task that never starts.
  const q = await dispatchRoot('ag-b');
  await check('queued root');

  await sweepSpecialistTasks();
  await check('first sweep');
  await sweepSpecialistTasks();
  await check('second sweep');

  return { r1, s1, m1, r2, s2, r3, s3, p4, pc, ps, hr, cr, bf, gd, q };
}

beforeEach(async () => {
  fs.rmSync(env.root, { recursive: true, force: true });
  fs.mkdirSync(env.root, { recursive: true });
  env.running.clear();
  env.boot.clear();
  await runMigrations(await initTestDb());
  await group('ag-main');
  await setMainGroup('ag-main');
  await group('ag-other');
  await group('ag-plain');
  await group('ag-a', 'specialist');
  await group('ag-b', 'specialist');
  await group('ag-mem', 'memory');
  await mkSession('sess-main', 'ag-main', null);
  await mkSession('sess-other', 'ag-other', null);
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(env.root, { recursive: true, force: true });
});

// ── Surface ──────────────────────────────────────────────────────────────────

obligation('surface-actor.SpecialistMcpTools', async () => {
  // The facing actor is the agent's Session: each tool reaches the host as a
  // system action from that session's outbound, and acts as that session.
  const dispatch = getDeliveryAction('dispatch_specialist')!;
  await dispatch({ action: 'dispatch_specialist', specialist_group_id: 'ag-a', prompt: 'p' }, await mainSession());
  const root = await newestTaskFrom('sess-main');
  expect(root.requester_session_id).toBe('sess-main');
  expect(root.requester_group_id).toBe('ag-main');

  // A session acts only for itself: the main session has no task of its own,
  // so it can neither delegate as a specialist nor deliver a task's result.
  const before = await allTasks();
  await getDeliveryAction('dispatch_sub_task')!({ specialist_group_id: 'ag-b', prompt: 'p' }, await mainSession());
  await getDeliveryAction('deliver_specialist_result')!({ result_text: 'hijack' }, await mainSession());
  expect(await allTasks()).toEqual(before);

  // Another task's session cannot deliver for this one.
  const other = await dispatchRoot('ag-a');
  await getDeliveryAction('deliver_specialist_result')!({ result_text: 'mine' }, (await sessionOf(other))!);
  expect((await fresh(root)).status).toBe('queued');
  expect((await fresh(other)).status).toBe('completed');
});

obligation('surface-provides.SpecialistMcpTools', async () => {
  // The surface declares no `when` guards: all three operations are always
  // provided, each wired to its handler.
  expect(getDeliveryAction('dispatch_specialist')).toBe(handleDispatchSpecialist);
  expect(getDeliveryAction('dispatch_sub_task')).toBe(handleDispatchSubTask);
  expect(getDeliveryAction('deliver_specialist_result')).toBe(handleDeliverSpecialistResult);
});

// ── Enums ────────────────────────────────────────────────────────────────────

obligation('enum-comparable.SpecialistTaskStatus', async () => {
  // Every spec literal round-trips through the status column and the code's
  // live/terminal comparisons classify it as the spec does.
  for (const status of TASK_STATUSES) {
    const t = await seedTask({ id: `task-${status}`, specialist_group_id: 'ag-a', status: status as never });
    expect((await fresh(t)).status).toBe(status);
    const live = await getLiveTaskForSession((await sessionOf(t))!);
    expect(live?.id, status).toBe(TERMINAL.has(status) ? undefined : t.id);
  }
  const liveIds = (await getLiveTasksWithSessions()).map((t) => t.status).sort();
  expect(liveIds).toEqual(TASK_STATUSES.filter((s) => !TERMINAL.has(s)).sort());

  // Every status the code writes is a spec literal.
  const seen = new Set<string>();
  await busyWorld(async () => {
    for (const t of await allTasks()) seen.add(t.status);
  });
  for (const s of seen) expect(TASK_STATUSES).toContain(s);
  expect(seen.size).toBeGreaterThanOrEqual(5);
});

obligation('enum-comparable.SpecialistFailureKind', async () => {
  await busyWorld();
  const kinds = new Set((await allTasks()).flatMap((t) => (t.failure_kind ? [t.failure_kind] : [])));
  // The code produces exactly the spec's kinds — every one of them, and nothing else.
  expect([...kinds].sort()).toEqual([...FAILURE_KINDS].sort());
});

obligation('enum-comparable.IpcMountStatus', async () => {
  const seen = new Set<string>();
  await busyWorld(async () => {
    for (const table of ['ipc_out_mounts', 'ipc_in_mounts']) {
      for (const r of await getDb().all<{ status: string }>(`SELECT status FROM ${table}`)) seen.add(r.status);
    }
  });
  expect([...seen].sort()).toEqual([...MOUNT_STATUSES].sort());
});

obligation('enum-comparable.TransferStatus', async () => {
  const seen = new Set<string>();
  await busyWorld(async () => {
    for (const t of await allTransfers()) seen.add(t.status);
  });
  for (const s of seen) expect(TRANSFER_STATUSES).toContain(s);
  // `committed` is passed through inside one transaction on the commit path,
  // so it is never visible between steps; the rest are.
  expect(seen).toEqual(new Set(['pending', 'in_transit', 'expired']));
});

obligation('enum-comparable.TransferFileStatus', async () => {
  const seen = new Set<string>();
  await busyWorld(async () => {
    for (const f of await allFiles()) seen.add(f.status);
  });
  expect([...seen].sort()).toEqual([...TRANSFER_FILE_STATUSES].sort());
});

// ── Value types ──────────────────────────────────────────────────────────────

obligation('value-equality.TaskFailure', async () => {
  const failureOf = (t: SpecialistTask) => ({ kind: t.failure_kind, detail: t.failure_detail });
  const root = await seedTask({ id: 'task-root', specialist_group_id: 'ag-a' });
  const deep = { depth: 4, ancestor_group_ids: JSON.stringify(['ag-a', 'ag-a', 'ag-a', 'ag-a']) };
  const p1 = await seedSub(root, { id: 'task-p1', specialist_group_id: 'ag-a', ...deep });
  const p2 = await seedSub(root, { id: 'task-p2', specialist_group_id: 'ag-a', ...deep });
  const p3 = await seedSub(root, { id: 'task-p3', specialist_group_id: 'ag-a', chain_delegation_count: 20 });
  const a = (await dispatchSub(p1, 'ag-b'))!;
  const b = (await dispatchSub(p2, 'ag-b'))!;
  const c = (await dispatchSub(p3, 'ag-b'))!;
  // Two failures built separately with the same kind and detail are the same value…
  expect(failureOf(a)).toEqual(failureOf(b));
  expect(failureOf(a)).toEqual({ kind: 'depth_exceeded', detail: 'specialist chain depth limit reached' });
  // …and differ when a component differs.
  expect(failureOf(c)).not.toEqual(failureOf(a));
});

obligation('entity-fields.TaskFailure', async () => {
  await busyWorld();
  const failed = (await allTasks()).filter((t) => t.status === 'failed');
  expect(failed.length).toBeGreaterThan(0);
  for (const t of failed) {
    expect(FAILURE_KINDS, t.id).toContain(t.failure_kind);
    expect(typeof t.failure_detail, t.id).toBe('string');
    expect(t.failure_detail!.length, t.id).toBeGreaterThan(0);
  }
});

obligation('value-equality.Invocation', async () => {
  const root = await dispatchRoot('ag-a');
  const s = (await sessionOf(root))!;
  const built = (await buildInvocationForSession(s))!;
  const read1 = await getActiveInvocation(s.id);
  const read2 = await getActiveInvocation(s.id);
  // The same invocation read twice is equal by value…
  expect(read1).toEqual(read2);
  expect(read1!.id).toBe(built.invocationId);
  // …and a later run of the same session is a different value.
  await buildInvocationForSession(s);
  const next = await getActiveInvocation(s.id);
  expect(next).not.toEqual(read1);
  expect(next!.session_id).toBe(read1!.session_id);
});

obligation('entity-fields.Invocation', async () => {
  const root = await dispatchRoot('ag-a');
  const taskSession = (await sessionOf(root))!;
  await buildInvocationForSession(taskSession);
  await buildInvocationForSession(await mainSession());
  const forTask = (await getActiveInvocation(taskSession.id)) as Invocation;
  const forMain = (await getActiveInvocation('sess-main')) as Invocation;

  expect(typeof forTask.id).toBe('string');
  expect(forTask.session_id).toBe(taskSession.id);
  // task: non-null exactly when the invocation runs a specialist task.
  expect(forTask.task_id).toBe(root.id);
  expect(forMain.session_id).toBe('sess-main');
  expect(forMain.task_id).toBeNull();
  expect(forTask.started_at).toMatch(ISO);
  expect(forTask.ended_at).toBeNull();
});

// ── Config defaults ──────────────────────────────────────────────────────────

obligation('config-default.max_specialist_depth', () => {
  expect(SPECIALISTS_CONFIG.maxSpecialistDepth).toBe(5);
});

obligation('config-default.max_chain_delegations', () => {
  expect(SPECIALISTS_CONFIG.maxChainDelegations).toBe(20);
});

obligation('config-default.max_same_type_dispatches', () => {
  expect(SPECIALISTS_CONFIG.maxSameTypeDispatches).toBe(3);
});

obligation('config-default.max_task_duration', () => {
  expect(SPECIALISTS_CONFIG.maxTaskDurationMs).toBe(4 * 60 * 60 * 1000);
});

obligation('config-default.max_sub_task_await', () => {
  expect(SPECIALISTS_CONFIG.maxSubTaskAwaitMs).toBe(30 * 60 * 1000);
});

obligation('config-default.max_restart_retries', () => {
  expect(SPECIALISTS_CONFIG.maxRestartRetries).toBe(2);
});

obligation('config-default.default_last_turn_sub_notice', () => {
  expect(SPECIALISTS_CONFIG.defaultLastTurnSubNotice).toBe(
    '[Final iteration: this is your last opportunity to respond. Provide your best conclusive output as no further iterations will occur.]',
  );
});

obligation('config-default.default_last_turn_parent_notice', () => {
  expect(SPECIALISTS_CONFIG.defaultLastTurnParentNotice).toBe(
    '[Final iteration: no further responses will follow from this specialist. Incorporate this as your final input and conclude your work.]',
  );
});

obligation('config-default.ipc_out_container_path', () => {
  expect(SPECIALISTS_CONFIG.ipcOutContainerPath).toBe('/workspace/ipc-out');
});

obligation('config-default.ipc_in_container_path', () => {
  expect(SPECIALISTS_CONFIG.ipcInContainerPath).toBe('/workspace/ipc-in');
});

obligation('config-default.memory_reports_subpath', () => {
  expect(SPECIALISTS_CONFIG.memoryReportsSubpath).toBe('zettel/reports');
});

// ── SpecialistTask: when-presence ────────────────────────────────────────────

obligation('when-presence.SpecialistTask.pending_sub_task', async () => {
  const holds = async (step: string) => {
    for (const t of await allTasks()) {
      expect(t.pending_sub_task_id != null, `${step}: ${t.id} (${t.status})`).toBe(t.status === 'awaiting_sub_task');
      if (t.pending_sub_task_id) {
        expect((await getTask(t.pending_sub_task_id))?.requester_task_id, step).toBe(t.id);
      }
    }
  };
  const w = await busyWorld(holds);
  // Also through the sub-task await timeout (parent -> awaiting_restart).
  const parent = (await dispatchSub(w.q, 'ag-a'))!.requester_task_id!;
  const child = (await getTask(parent))!.pending_sub_task_id!;
  await getDb().run('UPDATE specialist_tasks SET dispatched_at = ? WHERE id = ?', ago(31 * 60_000), child);
  await sweepSpecialistTasks();
  expect((await getTask(parent))!.status).toBe('awaiting_restart');
  await holds('after sub-task await timeout');
});

obligation('when-presence.SpecialistTask.result', async () => {
  await busyWorld(async (step) => {
    for (const t of await allTasks()) {
      expect(t.result != null, `${step}: ${t.id} (${t.status})`).toBe(t.status === 'completed');
    }
  });
});

obligation('when-presence.SpecialistTask.committed_files', async () => {
  const w = await busyWorld(async (step) => {
    for (const t of await allTasks()) {
      if (t.status !== 'completed') expect(t.committed_files, `${step}: ${t.id} (${t.status})`).toBeNull();
    }
  });
  // Present on the completed task that committed files.
  expect(JSON.parse((await fresh(w.r1)).committed_files!)).toEqual([
    `${SPECIALISTS_CONFIG.memoryReportsSubpath}/report.md`,
  ]);
});

obligation('when-presence.SpecialistTask.failure', async () => {
  await busyWorld(async (step) => {
    for (const t of await allTasks()) {
      const label = `${step}: ${t.id} (${t.status})`;
      expect(t.failure_kind != null, label).toBe(t.status === 'failed');
      expect(t.failure_detail != null, label).toBe(t.status === 'failed');
    }
  });
});

// ── SpecialistTask: entity invariants ────────────────────────────────────────

divergence(
  'invariant.SpecialistTask.ExactlyOneRequester',
  'deleting a group clears requester_task_id on surviving tasks (group-delete.ts deleteSpecialistRowsForGroup, "UPDATE specialist_tasks SET requester_task_id = NULL"), leaving a sub-task of a deleted root with neither requester; the spec says requester links are never cleared',
  async () => {
    // Main requests a root task in ag-a, which delegates to ag-b. The main group is deleted.
    const root = await dispatchRoot('ag-a');
    const child = (await dispatchSub(root, 'ag-b'))!;
    await failTasksOfDeletedGroup('ag-main');
    await deleteSpecialistRowsForGroup(getDb(), 'ag-main');

    const survivor = await getTask(child.id);
    expect(survivor).toBeDefined();
    expect(
      (survivor!.requester_group_id != null) !== (survivor!.requester_task_id != null),
      'exactly one of requester_group / requester_task',
    ).toBe(true);
  },
);

obligation('invariant.SpecialistTask.DepthMatchesAncestorCount', async () => {
  await busyWorld(async (step) => {
    for (const t of await allTasks()) {
      const ancestors = JSON.parse(t.ancestor_group_ids) as string[];
      expect(t.depth, `${step}: ${t.id}`).toBe(ancestors.length);
    }
  });
});

obligation('invariant.SpecialistTask.SpecialistGroupMustBeSpecialist', async () => {
  await busyWorld(async (step) => {
    const specialists = new Set(
      (await getDb().all<{ agent_group_id: string }>('SELECT agent_group_id FROM specialists')).map(
        (r) => r.agent_group_id,
      ),
    );
    for (const t of await allTasks()) expect(specialists.has(t.specialist_group_id), `${step}: ${t.id}`).toBe(true);
  });
  // The rejected dispatches to a non-specialist group created nothing.
  expect((await allTasks()).filter((t) => t.specialist_group_id === 'ag-plain')).toEqual([]);
});

obligation('entity-fields.SpecialistTask', async () => {
  const root = await dispatchRoot('ag-a');
  const sub = (await dispatchSub(root, 'ag-b'))!;
  for (const t of [root, sub, await fresh(root)]) {
    expect(typeof t.id).toBe('string');
    expect(typeof t.specialist_group_id).toBe('string');
    expect(typeof t.prompt).toBe('string');
    expect(typeof t.requester_session_id).toBe('string');
    expect(Number.isInteger(t.depth)).toBe(true);
    expect(Number.isInteger(t.chain_delegation_count)).toBe(true);
    const ancestors = JSON.parse(t.ancestor_group_ids);
    expect(Array.isArray(ancestors)).toBe(true);
    for (const g of ancestors) expect(typeof g).toBe('string');
    expect([0, 1]).toContain(t.is_last_same_type_dispatch);
    expect(TASK_STATUSES).toContain(t.status);
    expect(t.dispatched_at).toMatch(ISO);
    expect(Number.isInteger(t.restart_attempt_count)).toBe(true);
    for (const k of [
      'closed_at',
      'result',
      'failure_kind',
      'failure_detail',
      'pending_sub_task_id',
      'committed_files',
    ]) {
      expect(k in t, k).toBe(true);
    }
  }
  // ancestor_groups is the ordered list of groups above the task.
  expect(JSON.parse(sub.ancestor_group_ids)).toEqual(['ag-a']);
  expect(sub.specialist_group_id).toBe('ag-b');
});

obligation('entity-optional.SpecialistTask.requester_group', async () => {
  const root = await dispatchRoot('ag-a');
  const sub = (await dispatchSub(root, 'ag-b'))!;
  expect(root.requester_group_id).toBe('ag-main');
  expect(sub.requester_group_id).toBeNull();
});

obligation('entity-optional.SpecialistTask.requester_task', async () => {
  const root = await dispatchRoot('ag-a');
  const sub = (await dispatchSub(root, 'ag-b'))!;
  expect(root.requester_task_id).toBeNull();
  expect(sub.requester_task_id).toBe(root.id);
});

obligation('entity-optional.SpecialistTask.closed_at', async () => {
  const root = await dispatchRoot('ag-a');
  expect((await fresh(root)).closed_at).toBeNull();
  await deliver(root, 'done');
  expect((await fresh(root)).closed_at).toMatch(ISO);
});

obligation('entity-optional.SpecialistTask.committed_files', async () => {
  const text = await dispatchRoot('ag-a');
  await deliver(text, 'just text');
  expect((await fresh(text)).committed_files).toBeNull();

  const withFiles = await dispatchRoot('ag-a');
  await deliver(withFiles, 'see report.md', { 'report.md': 'R' }, true);
  expect(JSON.parse((await fresh(withFiles)).committed_files!)).toEqual([
    `${SPECIALISTS_CONFIG.memoryReportsSubpath}/report.md`,
  ]);
});

// ── SpecialistTask: derived values ───────────────────────────────────────────

obligation('derived.SpecialistTask.is_overdue', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
  const max = SPECIALISTS_CONFIG.maxTaskDurationMs;

  // Exactly max_task_duration old: not overdue (spec: now - dispatched_at > max).
  const edge = await seedTask({
    id: 'task-edge',
    specialist_group_id: 'ag-a',
    status: 'queued',
    dispatched_at: ago(max),
  });
  // Overdue in every live status.
  const over: SpecialistTask[] = [];
  for (const status of ['queued', 'running', 'awaiting_sub_task', 'awaiting_restart'] as const) {
    over.push(
      await seedTask({ id: `task-over-${status}`, specialist_group_id: 'ag-a', status, dispatched_at: ago(max + 1) }),
    );
  }
  // A terminal task is never overdue.
  const done = await seedTask({
    id: 'task-done',
    specialist_group_id: 'ag-a',
    status: 'completed',
    result: 'r',
    closed_at: ago(max),
    dispatched_at: ago(max * 2),
  });

  await sweepSpecialistTasks();

  expect((await fresh(edge)).status).toBe('queued');
  for (const t of over) {
    const f = await fresh(t);
    expect([f.status, f.failure_kind], t.id).toEqual(['failed', 'timeout']);
  }
  expect((await fresh(done)).status).toBe('completed');
});

divergence(
  'derived.SpecialistTask.sub_task_await_overdue',
  'the sweep tests childAge > max_sub_task_await (recovery.ts sweepTask path 2), so a child exactly max_sub_task_await old is not overdue; the spec says (pending_sub_task.dispatched_at + max_sub_task_await) <= now',
  async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const awaitMs = SPECIALISTS_CONFIG.maxSubTaskAwaitMs;

    const parent = await seedTask({ id: 'task-parent', specialist_group_id: 'ag-a', status: 'awaiting_sub_task' });
    const child = await seedSub(parent, { id: 'task-child', specialist_group_id: 'ag-b', status: 'queued' });
    await getDb().run('UPDATE specialist_tasks SET pending_sub_task_id = ? WHERE id = ?', child.id, parent.id);

    // Just inside the window: not overdue.
    await getDb().run('UPDATE specialist_tasks SET dispatched_at = ? WHERE id = ?', ago(awaitMs - 1), child.id);
    await sweepSpecialistTasks();
    expect((await fresh(parent)).status).toBe('awaiting_sub_task');

    // At the boundary: overdue, so the parent is restarted.
    await getDb().run('UPDATE specialist_tasks SET dispatched_at = ? WHERE id = ?', ago(awaitMs), child.id);
    await sweepSpecialistTasks();
    expect((await fresh(parent)).status).toBe('awaiting_restart');
  },
);

// ── File handover entities ───────────────────────────────────────────────────

obligation('entity-fields.IpcOutMount', async () => {
  const root = await dispatchRoot('ag-a');
  const built = (await buildInvocationForSession((await sessionOf(root))!))!;
  const rows = await getDb().all<{ id: string; invocation_id: string; status: string }>('SELECT * FROM ipc_out_mounts');
  expect(rows).toHaveLength(1);
  expect(typeof rows[0].id).toBe('string');
  expect(rows[0].invocation_id).toBe(built.invocationId);
  expect(rows[0].status).toBe('active');
  // Read-write to the container, at the configured path.
  expect(built.mounts).toContainEqual(
    expect.objectContaining({ containerPath: SPECIALISTS_CONFIG.ipcOutContainerPath, readonly: false }),
  );
});

obligation('entity-fields.IpcInMount', async () => {
  const root = await dispatchRoot('ag-a');
  const built = (await buildInvocationForSession((await sessionOf(root))!))!;
  const rows = await getDb().all<{ id: string; invocation_id: string; status: string }>('SELECT * FROM ipc_in_mounts');
  expect(rows).toHaveLength(1);
  expect(typeof rows[0].id).toBe('string');
  expect(rows[0].invocation_id).toBe(built.invocationId);
  expect(rows[0].status).toBe('active');
  // Read-only to the container, at the configured path.
  expect(built.mounts).toContainEqual(
    expect.objectContaining({ containerPath: SPECIALISTS_CONFIG.ipcInContainerPath, readonly: true }),
  );
});

obligation('entity-fields.ContainerTransfer', async () => {
  const root = await dispatchRoot('ag-a');
  const rootSession = (await sessionOf(root))!;
  await deliver(root, `See ${SPECIALISTS_CONFIG.ipcOutContainerPath}/report.md`, { 'report.md': 'R' }, false);
  const sender = await getDb().get<Invocation>('SELECT * FROM invocations WHERE session_id = ?', rootSession.id);

  const [t] = await allTransfers();
  expect(t.task_id).toBe(root.id);
  expect(t.sender_invocation_id).toBe(sender!.id);
  // The rewritten text the requester sees.
  expect(t.result_text).toBe(`See ${SPECIALISTS_CONFIG.ipcInContainerPath}/${t.id}/report.md`);
  expect(t.commit_to_memory).toBe(0);
  expect(t.file_count).toBe(1);
  expect(t.sent_at).toMatch(ISO);
  expect(TRANSFER_STATUSES).toContain(t.status);
  expect('routed_message_id' in t).toBe(true);
});

obligation('entity-optional.ContainerTransfer.routed_message', async () => {
  // A root result with staged files: set to the message that carried it.
  const root = await dispatchRoot('ag-a');
  await deliver(root, 'see a.md', { 'a.md': 'A' }, false);
  // A sub-task result with files: null (it expires with the parent task).
  const parent = await dispatchRoot('ag-a');
  const child = (await dispatchSub(parent, 'ag-b'))!;
  await deliver(child, 'see b.md', { 'b.md': 'B' });

  const byTask = new Map((await allTransfers()).map((t) => [t.task_id, t]));
  expect(typeof byTask.get(root.id)!.routed_message_id).toBe('string');
  expect(byTask.get(child.id)!.routed_message_id).toBeNull();
});

obligation('entity-relationship.ContainerTransfer.files', async () => {
  const a = await dispatchRoot('ag-a');
  await deliver(a, 'two files', { 'one.md': '1', 'two.md': '2' });
  const b = await dispatchRoot('ag-b');
  await deliver(b, 'one file', { 'three.md': '3' });

  for (const t of await allTransfers()) {
    const files = await getDb().all<TransferFile>('SELECT * FROM transfer_files WHERE transfer_id = ?', t.id);
    expect(files).toHaveLength(t.file_count);
    for (const f of files) expect(f.transfer_id).toBe(t.id);
  }
  const namesOf = async (taskId: string) =>
    (
      await getDb().all<{ original_name: string }>(
        `SELECT f.original_name FROM transfer_files f JOIN container_transfers t ON t.id = f.transfer_id
         WHERE t.task_id = ? ORDER BY f.original_name`,
        taskId,
      )
    ).map((r) => r.original_name);
  expect(await namesOf(a.id)).toEqual(['one.md', 'two.md']);
  expect(await namesOf(b.id)).toEqual(['three.md']);
});

obligation('entity-fields.TransferFile', async () => {
  const parent = await dispatchRoot('ag-a');
  const child = (await dispatchSub(parent, 'ag-b'))!;
  await deliver(child, 'see data.csv', { 'nested/data.csv': 'a,b' });

  const [transfer] = await allTransfers();
  const [f] = await allFiles();
  expect(typeof f.id).toBe('string');
  expect(f.transfer_id).toBe(transfer.id);
  expect(f.original_name).toBe('data.csv');
  expect(path.isAbsolute(f.host_path)).toBe(true);
  expect(fs.readFileSync(f.host_path, 'utf-8')).toBe('a,b');
  expect(f.status).toBe('owned');
  expect(f.memory_path).toBeNull();
});

obligation('entity-optional.TransferFile.memory_path', async () => {
  const staged = await dispatchRoot('ag-a');
  await deliver(staged, 'see s.md', { 's.md': 'S' }, false);
  const committed = await dispatchRoot('ag-a');
  await deliver(committed, 'see c.md', { 'c.md': 'C' }, true);

  const byName = new Map((await allFiles()).map((f) => [f.original_name, f]));
  expect(byName.get('s.md')!.memory_path).toBeNull();
  expect(byName.get('c.md')!.memory_path).toBe(`${SPECIALISTS_CONFIG.memoryReportsSubpath}/c.md`);
});

// ── Global invariants ────────────────────────────────────────────────────────

divergence(
  'invariant.SpecialistDispatchMainGroupOnly',
  'deleting a group clears requester_task_id on surviving tasks (group-delete.ts deleteSpecialistRowsForGroup), so a sub-task of a deleted root is left with requester_task = null and requester_group = null',
  async () => {
    const root = await dispatchRoot('ag-a');
    const child = (await dispatchSub(root, 'ag-b'))!;
    await failTasksOfDeletedGroup('ag-main');
    await deleteSpecialistRowsForGroup(getDb(), 'ag-main');

    for (const t of await allTasks()) {
      if (t.requester_task_id != null) continue;
      expect(t.requester_group_id, t.id).not.toBeNull();
      const g = await getDb().get<{ is_main: number }>(
        'SELECT is_main FROM agent_groups WHERE id = ?',
        t.requester_group_id,
      );
      expect(g?.is_main, t.id).toBe(1);
    }
    expect(await getTask(child.id)).toBeDefined();
  },
);

obligation('invariant.MemoryProviderDoesNotDelegate', async () => {
  await busyWorld(async (step) => {
    const providers = new Set(
      (
        await getDb().all<{ agent_group_id: string }>(
          'SELECT agent_group_id FROM specialists WHERE is_memory_provider = 1',
        )
      ).map((r) => r.agent_group_id),
    );
    for (const t of await allTasks()) {
      if (!t.requester_task_id) continue;
      const parent = (await getTask(t.requester_task_id))!;
      expect(providers.has(parent.specialist_group_id), `${step}: ${t.id}`).toBe(false);
    }
  });
});

divergence(
  'invariant.TaskDepthBounded',
  "a depth rejection records the rejected task with depth = parent.depth + 1 = max_specialist_depth (dispatch.ts handleDispatchSubTask depth-limit branch) — as the spec's own SubTaskRejectedDepth prescribes, so the invariant and that rule disagree",
  async () => {
    const root = await seedTask({ id: 'task-root', specialist_group_id: 'ag-a' });
    const deep = await seedSub(root, {
      id: 'task-deep',
      specialist_group_id: 'ag-a',
      depth: 4,
      ancestor_group_ids: JSON.stringify(['ag-a', 'ag-a', 'ag-a', 'ag-a']),
    });
    await dispatchSub(deep, 'ag-b');
    for (const t of await allTasks()) {
      expect(t.depth, t.id).toBeLessThan(SPECIALISTS_CONFIG.maxSpecialistDepth);
    }
  },
);

obligation('invariant.ClosedAtPresentWhenTerminal', async () => {
  await busyWorld(async (step) => {
    for (const t of await allTasks()) {
      expect(t.closed_at != null, `${step}: ${t.id} (${t.status})`).toBe(TERMINAL.has(t.status));
    }
  });
});

obligation('invariant.RunningTaskIsLeaf', async () => {
  let sawRunningChild = false;
  await busyWorld(async (step) => {
    const tasks = await allTasks();
    for (const parent of tasks.filter((t) => t.status === 'running')) {
      for (const child of tasks.filter((t) => t.requester_task_id === parent.id)) {
        expect(child.status, `${step}: ${parent.id} -> ${child.id}`).not.toBe('running');
      }
    }
    if (tasks.some((t) => t.status === 'running' && t.requester_task_id)) sawRunningChild = true;
  });
  expect(sawRunningChild).toBe(true);
});

obligation('invariant.CommitAndPlaceMutuallyExclusive', async () => {
  let sawMemoryPath = false;
  await busyWorld(async (step) => {
    for (const t of await allTransfers()) {
      for (const f of await getDb().all<TransferFile>('SELECT * FROM transfer_files WHERE transfer_id = ?', t.id)) {
        if (f.memory_path != null) {
          sawMemoryPath = true;
          expect(t.commit_to_memory, `${step}: ${f.id}`).toBe(1);
        }
        if (f.status === 'placed') expect(t.commit_to_memory, `${step}: ${f.id}`).toBe(0);
      }
    }
  });
  expect(sawMemoryPath).toBe(true);
});

obligation('invariant.IpcInPathsUniquePerTransfer', async () => {
  // Two different files with one basename, and one file listed twice.
  const t = await dispatchRoot('ag-a');
  const s = (await sessionOf(t))!;
  await buildInvocationForSession(s);
  const inv = (await getActiveInvocation(s.id))!;
  fs.mkdirSync(path.join(inv.ipc_out_host_path, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(inv.ipc_out_host_path, 'report.md'), 'one');
  fs.writeFileSync(path.join(inv.ipc_out_host_path, 'sub', 'report.md'), 'two');
  const out = SPECIALISTS_CONFIG.ipcOutContainerPath;
  await handleDeliverSpecialistResult(
    { result_text: 'r', file_paths: [`${out}/report.md`, `${out}/sub/report.md`, 'report.md'] },
    s,
  );
  await busyWorld();

  for (const transfer of await allTransfers()) {
    const names = (
      await getDb().all<{ original_name: string }>(
        'SELECT original_name FROM transfer_files WHERE transfer_id = ?',
        transfer.id,
      )
    ).map((r) => r.original_name);
    expect(new Set(names).size, transfer.id).toBe(names.length);
  }
  const first = (await allTransfers()).find((x) => x.task_id === t.id)!;
  expect(first.file_count).toBe(2);
});

obligation('invariant.TransferAndFilesInSync', async () => {
  let sawExpired = false;
  await busyWorld(async (step) => {
    for (const t of await allTransfers()) {
      if (t.status !== 'expired') continue;
      sawExpired = true;
      const files = await getDb().all<TransferFile>('SELECT * FROM transfer_files WHERE transfer_id = ?', t.id);
      for (const f of files) expect(f.status, `${step}: ${t.id}/${f.id}`).toBe('expired');
    }
  });
  expect(sawExpired).toBe(true);
});

obligation('invariant.AtMostOneActiveInvocationPerSession', async () => {
  const holds = async (step: string) => {
    const rows = await getDb().all<{ session_id: string; n: number }>(
      `SELECT i.session_id, COUNT(*) AS n FROM ipc_out_mounts m JOIN invocations i ON i.id = m.invocation_id
       WHERE m.status = 'active' GROUP BY i.session_id`,
    );
    for (const r of rows) expect(r.n, `${step}: ${r.session_id}`).toBe(1);
  };
  await busyWorld(holds);
  // A new start for a session whose previous invocation never ended (the
  // container's exit was never observed) ends the orphan first.
  for (let i = 0; i < 3; i++) await buildInvocationForSession(await mainSession());
  await holds('repeated starts');
  expect(
    (await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM invocations WHERE session_id = 'sess-main'"))!.n,
  ).toBeGreaterThanOrEqual(3);
});

covered(
  'invariant.QueuedTaskHasNoRestartAttempts',
  'src/modules/specialists/recovery.test.ts',
  'does not crash-detect a queued task even after multiple sweep ticks',
);

obligation('invariant.TerminalTaskHasClosedSession', async () => {
  let checked = 0;
  await busyWorld(async (step) => {
    for (const t of await allTasks()) {
      if (!TERMINAL.has(t.status)) continue;
      const s = await sessionOf(t);
      if (!s) continue;
      checked++;
      expect(s.status, `${step}: ${t.id} (${t.status}${t.failure_kind ? `/${t.failure_kind}` : ''})`).toBe('closed');
    }
  });
  expect(checked).toBeGreaterThan(0);
});
