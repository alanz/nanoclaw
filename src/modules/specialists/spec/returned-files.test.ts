/**
 * Propagated from specs/specialists.allium — the host's guarantee for named
 * files (NamedFilesNeverLost): refused dispatches give their files back
 * (MainDispatchRefused, SubTaskDispatchRefused, RefusedDispatchFilesReturned),
 * returned files reach a running recipient (ReturnedFilesPlacedIntoLiveIpcIn,
 * TransferPlacedIntoRunningInvocation), files with no reader left are parked
 * (ReturnedFilesOrphanedWithoutRecipient, ReturnedTransferEndsWithRecipientTask,
 * TransferParked), handover calls are handled before an invocation's ipc-out
 * goes (InvocationEnded / OrphanInvocationEnded handover_calls_handled), the
 * ReturnedTransferNeverCommits invariant, and the ContainerTransfer /
 * TransferFile fields that came with returned transfers and parking.
 *
 * Every test drives the real handlers (handleDispatchSpecialist,
 * handleDispatchSubTask, handleDeliverSpecialistResult, routeResult) and the
 * real invocation lifecycle (buildInvocationForSession, endInvocationById)
 * against a migrated test DB and real temp directories. Only the container
 * runtime, the session mailbox (writes captured, acks scripted), request-wake,
 * the null channel's presence and the host's outbound drain are faked.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-spec-returned-files';

const h = vi.hoisted(() => ({
  writes: [] as Array<{ sessionId: string; id: string; text: string; trigger: boolean }>,
  acked: [] as string[],
  failed: [] as string[],
  pending: [] as string[],
  /** Handover calls a container wrote to its outbox that the host has not handled yet, by session. */
  outbox: new Map<string, Array<Record<string, unknown>>>(),
}));

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-spec-returned-files/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-spec-returned-files/groups',
  };
});
vi.mock('../../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../container-runner.js')>()),
  wakeContainer: vi.fn(async () => true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn(() => false),
}));
vi.mock('../../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session-manager.js')>()),
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(
    async (_ag: string, sessionId: string, msg: { id: string; content: string; trigger?: boolean }) => {
      h.writes.push({ sessionId, id: msg.id, text: JSON.parse(msg.content).text, trigger: Boolean(msg.trigger) });
    },
  ),
  withExistingMailboxSession: vi.fn(async (_ag: string, _s: string, action: (m: unknown) => unknown) =>
    action({
      getTerminalProcessingAcks: () => [
        ...h.acked.map((messageId) => ({ messageId, status: 'completed' })),
        ...h.failed.map((messageId) => ({ messageId, status: 'failed' })),
      ],
      getMessageForRetry: (id: string, status: 'pending' | 'processing') =>
        status === 'pending' && h.pending.includes(id) ? { id } : undefined,
      failPendingMessages: () => undefined,
      countDueMessages: () => 0,
      getProcessingClaims: () => [],
    }),
  ),
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../../channels/null-channel.js', () => ({
  NULL_CHANNEL_TYPE: 'null_channel',
  NULL_CHANNEL_PLATFORM_ID: 'specialist',
  getNullMessagingGroupId: async () => 'mg-null',
}));
// The host's outbound drain: handles the handover calls a session's container
// left in its outbox, as the real delivery poll does with outbound.db rows.
vi.mock('../../../delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../delivery.js')>()),
  deliverSessionMessages: vi.fn(async (session: { id: string }) => {
    const calls = h.outbox.get(session.id) ?? [];
    h.outbox.delete(session.id);
    const { handleDispatchSpecialist } = await import('../dispatch.js');
    for (const call of calls) await handleDispatchSpecialist(call, session as never);
  }),
}));

import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { createMessagingGroup } from '../../../db/messaging-groups.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createSession } from '../../../db/sessions.js';
import type { Session } from '../../../types.js';
import { SPECIALISTS_CONFIG } from '../config.js';
import { createSpecialist, createTask, getTask } from '../db.js';
import { handleDeliverSpecialistResult } from '../delivery.js';
import { handleDispatchSpecialist, handleDispatchSubTask } from '../dispatch.js';
import { parkTransfer } from '../handover.js';
import {
  buildInvocationForSession,
  endInvocationById,
  invocationIpcOutPath,
  placeTransferIntoActiveIpcIn,
  TRANSFERS_BASE_DIR,
} from '../invocation.js';
import { routeResult } from '../routing.js';
import type { ContainerTransfer, SpecialistTask, TransferFile } from '../types.js';
import { covered, divergence, obligation } from './harness.js';

const now = () => new Date().toISOString();
const IPC_OUT = SPECIALISTS_CONFIG.ipcOutContainerPath;
const IPC_IN = SPECIALISTS_CONFIG.ipcInContainerPath;
const ORPHANS = SPECIALISTS_CONFIG.orphanSubpath;
const GROUPS = path.join(ROOT, 'groups');

// ── world ────────────────────────────────────────────────────────────────────

async function group(id: string, kind: 'plain' | 'main' | 'specialist'): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  if (kind === 'main') await getDb().run('UPDATE agent_groups SET is_main = 1 WHERE id = ?', id);
  if (kind !== 'specialist') return;
  await createSpecialist({
    agent_group_id: id,
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
}

async function session(id: string, agentGroupId: string, threadId: string | null): Promise<Session> {
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
  } as never);
  return sessionRow(id);
}

const sessionRow = async (id: string) => (await getDb().get<Session>('SELECT * FROM sessions WHERE id = ?', id))!;

/** A running root task of ag-a dispatched by ag-main, with session sess-parent. */
async function parent(opts: { depth?: number } = {}): Promise<Session> {
  const s = await session('sess-parent', 'ag-a', 'task-parent');
  const depth = opts.depth ?? 0;
  await createTask({
    id: 'task-parent',
    specialist_group_id: 'ag-a',
    prompt: 'parent work',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth,
    chain_delegation_count: 1,
    ancestor_group_ids: JSON.stringify(Array(depth).fill('ag-b')),
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
  return s;
}

async function start(s: Session | string): Promise<string> {
  const built = await buildInvocationForSession(typeof s === 'string' ? await sessionRow(s) : s);
  return built!.invocationId;
}

function stage(invocationId: string, name: string, content = `contents of ${name}`): string {
  fs.writeFileSync(path.join(invocationIpcOutPath(invocationId), name), content);
  return `${IPC_OUT}/${name}`;
}

const allTasks = () => getDb().all<SpecialistTask>('SELECT * FROM specialist_tasks');
const transfers = () => getDb().all<ContainerTransfer>('SELECT * FROM container_transfers ORDER BY sent_at, rowid');
const transferById = async (id: string) => (await transfers()).find((t) => t.id === id)!;
const ofKind = async (kind: string) => (await transfers()).filter((t) => t.kind === kind);
const filesOf = (transferId: string) =>
  getDb().all<TransferFile>('SELECT * FROM transfer_files WHERE transfer_id = ?', transferId);
const sessionOf = (taskId: string) => getDb().get<Session>('SELECT * FROM sessions WHERE thread_id = ?', taskId);
const triggersTo = (sessionId: string) => h.writes.filter((w) => w.sessionId === sessionId && w.trigger);
const ipcInOf = async (invocationId: string) =>
  ((await getDb().get('SELECT ipc_in_host_path AS p FROM invocations WHERE id = ?', invocationId)) as { p: string }).p;
const parkedFile = (groupFolder: string, transferId: string, name: string) =>
  path.join(GROUPS, groupFolder, ORPHANS, transferId, name);

/** The tasks created by `fn`. */
async function created(fn: () => Promise<void>): Promise<SpecialistTask[]> {
  const before = new Set((await allTasks()).map((t) => t.id));
  await fn();
  return (await allTasks()).filter((t) => !before.has(t.id));
}

/** Fail a task as the host does, and route it. */
async function fail(taskId: string): Promise<void> {
  await getDb().run(
    "UPDATE specialist_tasks SET status = 'failed', failure_kind = 'timeout', failure_detail = 'too slow', closed_at = ? WHERE id = ?",
    now(),
    taskId,
  );
  await routeResult((await getTask(taskId))!);
}

/** The main session's running invocation, if any. */
const liveMainRun = async () =>
  (
    await getDb().get<{ id: string }>(
      'SELECT id FROM invocations WHERE session_id = ? AND ended_at IS NULL',
      'sess-main',
    )
  )?.id;

/** Main dispatches ag-a with a file, from its running invocation (started if there is none). */
async function mainDispatch(name = 'paper.pdf'): Promise<{ task: SpecialistTask; mainRun: string }> {
  const main = await sessionRow('sess-main');
  const mainRun = (await liveMainRun()) ?? (await start(main));
  const p = stage(mainRun, name);
  const [task] = await created(() =>
    handleDispatchSpecialist({ specialist_group_id: 'ag-a', prompt: `Read ${p}.`, file_paths: [p] }, main),
  );
  return { task, mainRun };
}

beforeEach(async () => {
  h.writes.length = 0;
  h.acked = [];
  h.failed = [];
  h.pending = [];
  h.outbox.clear();
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  await createMessagingGroup({
    id: 'mg-null',
    channel_type: 'null_channel',
    platform_id: 'specialist',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await group('ag-main', 'main');
  await group('ag-plain', 'plain');
  await group('ag-a', 'specialist');
  await group('ag-b', 'specialist');
  await session('sess-main', 'ag-main', null);
  await session('sess-plain', 'ag-plain', null);
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── MainDispatchRefused ──────────────────────────────────────────────────────

describe('MainDispatchRefused', () => {
  obligation('rule-success.MainDispatchRefused', async () => {
    // A non-main caller names a file: no task; told why; the file comes back.
    const plain = await sessionRow('sess-plain');
    const run = await start(plain);
    const memo = stage(run, 'memo.txt');
    expect(
      await created(() =>
        handleDispatchSpecialist({ specialist_group_id: 'ag-a', prompt: 'p', file_paths: [memo] }, plain),
      ),
    ).toEqual([]);
    const [notice] = triggersTo('sess-plain');
    expect(notice.text).toContain(
      'dispatch_specialist failed: only the main group may dispatch root specialist tasks.',
    );
    const [back] = await ofKind('returned');
    expect(back.recipient_session_id).toBe('sess-plain');
    expect(notice.text).toContain(`${IPC_IN}/${back.id}/memo.txt`);

    // The main agent names a target that is no specialist, with no files:
    // just told (AgentNotified), nothing handed back.
    const main = await sessionRow('sess-main');
    expect(
      await created(() => handleDispatchSpecialist({ specialist_group_id: 'ag-plain', prompt: 'p' }, main)),
    ).toEqual([]);
    const [told] = triggersTo('sess-main');
    expect(told.text).toBe('dispatch_specialist failed: agent group "ag-plain" is not a specialist.');
    expect(await ofKind('returned')).toHaveLength(1);
  });

  obligation('rule-failure.MainDispatchRefused.1', async () => {
    // The root dispatch is possible: a task, its files handed to it, no refusal.
    const { task } = await mainDispatch();
    expect(task.status).toBe('queued');
    expect(triggersTo('sess-main')).toEqual([]);
    expect(await ofKind('returned')).toEqual([]);
    expect(await ofKind('dispatch')).toHaveLength(1);
  });
});

// ── SubTaskDispatchRefused ───────────────────────────────────────────────────

describe('SubTaskDispatchRefused', () => {
  obligation('rule-success.SubTaskDispatchRefused', async () => {
    // A specialist names a file and a target that is no specialist: no task,
    // told why, the file back in its ipc-in.
    const p = await parent();
    const run = await start(p);
    const chunk = stage(run, 'chunk.txt');
    expect(
      await created(() =>
        handleDispatchSubTask({ specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [chunk] }, p),
      ),
    ).toEqual([]);
    const [notice] = triggersTo('sess-parent');
    expect(notice.text).toContain('dispatch_sub_task failed: agent group "ag-plain" is not a specialist.');
    const [back] = await ofKind('returned');
    expect(back).toMatchObject({ recipient_session_id: 'sess-parent', task_id: null, failed_task_id: null });
    expect(notice.text).toContain(`${IPC_IN}/${back.id}/chunk.txt`);
    expect((await getTask('task-parent'))!.status).toBe('running');

    // A caller that is no specialist, no files: told, nothing handed back.
    const plain = await sessionRow('sess-plain');
    expect(await created(() => handleDispatchSubTask({ specialist_group_id: 'ag-a', prompt: 'p' }, plain))).toEqual([]);
    expect(triggersTo('sess-plain').map((w) => w.text)).toEqual([
      'dispatch_sub_task failed: caller is not a specialist agent group.',
    ]);
    expect(await ofKind('returned')).toHaveLength(1);
  });

  obligation('rule-failure.SubTaskDispatchRefused.1', async () => {
    // The sub-task dispatch is possible: a child, its files handed to it.
    const p = await parent();
    const run = await start(p);
    const chunk = stage(run, 'chunk.txt');
    const [child] = await created(() =>
      handleDispatchSubTask({ specialist_group_id: 'ag-b', prompt: 'p', file_paths: [chunk] }, p),
    );
    expect(child.status).toBe('queued');
    expect(triggersTo('sess-parent')).toEqual([]);
    expect(await ofKind('returned')).toEqual([]);
    expect((await ofKind('dispatch'))[0].task_id).toBe(child.id);
  });
});

// ── RefusedDispatchFilesReturned ─────────────────────────────────────────────

obligation('rule-success.RefusedDispatchFilesReturned', async () => {
  // The main agent (container up) names a real file and a missing one in a
  // refused dispatch.
  const main = await sessionRow('sess-main');
  const mainRun = await start(main);
  const memo = stage(mainRun, 'memo.txt', 'the memo');
  await handleDispatchSpecialist(
    { specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [memo, `${IPC_OUT}/missing.txt`] },
    main,
  );

  // A returned transfer to the caller, sent by its run, owning the one
  // deliverable file.
  const [back] = await transfers();
  expect(back).toMatchObject({
    kind: 'returned',
    task_id: null,
    failed_task_id: null,
    recipient_session_id: 'sess-main',
    sender_invocation_id: mainRun,
    commit_to_memory: 0,
    file_count: 1,
  });
  const [f] = await filesOf(back.id);
  expect(f.original_name).toBe('memo.txt');
  expect(f.host_path.startsWith(path.join(TRANSFERS_BASE_DIR, back.id))).toBe(true);

  // A triggering notice that names where the file is and what was not taken.
  const [notice] = triggersTo('sess-main');
  expect(notice.text).toContain('is not a specialist');
  expect(notice.text).toContain(`${IPC_IN}/${back.id}/memo.txt`);
  expect(notice.text).toContain(`[Not delivered: ${IPC_OUT}/missing.txt (no such file)]`);

  // The caller has no task: the notice is the transfer's routed message.
  expect(back.routed_message_id).toBe(notice.id);
  // Its container is up: placed live (TransferPlacedLive).
  expect(back.status).toBe('in_transit');
  expect(f).toMatchObject({ status: 'placed', reached_recipient: 1 });
  expect(fs.readFileSync(path.join(await ipcInOf(mainRun), back.id, 'memo.txt'), 'utf-8')).toBe('the memo');

  // A caller with a task keeps them for the task's life: no routed message.
  const p = await parent();
  const run = await start(p);
  const chunk = stage(run, 'chunk.txt');
  await handleDispatchSubTask({ specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [chunk] }, p);
  const toParent = (await ofKind('returned')).find((t) => t.recipient_session_id === 'sess-parent')!;
  expect(toParent.routed_message_id ?? null).toBeNull();
  expect(toParent.status).toBe('in_transit');
});

// ── handover_calls_handled ───────────────────────────────────────────────────

covered(
  'rule-failure.InvocationEnded.2',
  'src/modules/specialists/exit-drain.test.ts',
  'drains a session that is not a specialist task too: a handover call it made owns its files first',
);

obligation('rule-failure.OrphanInvocationEnded.4', async () => {
  // The main agent's run dispatched with a file, and its container went
  // silent before the host handled the call (no exit was reported).
  const main = await sessionRow('sess-main');
  const orphan = await start(main);
  const memo = stage(orphan, 'memo.txt');
  h.outbox.set('sess-main', [{ specialist_group_id: 'ag-a', prompt: `Read ${memo}.`, file_paths: [memo] }]);

  // The session's next run starts: the orphan is ended only after its
  // handover calls are handled, so the file is owned before ipc-out goes.
  await start(main);

  expect(fs.existsSync(invocationIpcOutPath(orphan))).toBe(false);
  const [given] = await ofKind('dispatch');
  expect(given).toBeDefined();
  expect((await filesOf(given.id)).map((f) => f.original_name)).toEqual(['memo.txt']);
});

// ── ReturnedFilesPlacedIntoLiveIpcIn ─────────────────────────────────────────

describe('ReturnedFilesPlacedIntoLiveIpcIn', () => {
  obligation('rule-success.ReturnedFilesPlacedIntoLiveIpcIn', async () => {
    const { task, mainRun } = await mainDispatch();
    await fail(task.id);
    const [back] = await ofKind('returned');
    expect(back.failed_task_id).toBe(task.id);
    expect(back.status).toBe('in_transit');
    expect((await filesOf(back.id))[0]).toMatchObject({ status: 'placed', reached_recipient: 1 });
    expect(fs.readFileSync(path.join(await ipcInOf(mainRun), back.id, 'paper.pdf'), 'utf-8')).toBe(
      'contents of paper.pdf',
    );
  });

  obligation('rule-failure.ReturnedFilesPlacedIntoLiveIpcIn.1', async () => {
    // The failed task was handed no files: nothing comes back.
    const main = await sessionRow('sess-main');
    const mainRun = await start(main);
    const [task] = await created(() => handleDispatchSpecialist({ specialist_group_id: 'ag-a', prompt: 'p' }, main));
    await fail(task.id);
    expect(await ofKind('returned')).toEqual([]);
    expect(fs.readdirSync(await ipcInOf(mainRun))).toEqual([]);
  });

  obligation('rule-failure.ReturnedFilesPlacedIntoLiveIpcIn.2', async () => {
    // The returned transfer is no longer pending (already placed) when the
    // result is ready again: it is not placed a second time.
    const { task, mainRun } = await mainDispatch();
    await fail(task.id);
    const [back] = await ofKind('returned');
    const placed = path.join(await ipcInOf(mainRun), back.id, 'paper.pdf');
    fs.writeFileSync(placed, 'read and annotated by the agent');

    await routeResult((await getTask(task.id))!);

    expect(await ofKind('returned')).toHaveLength(1);
    expect((await transferById(back.id)).status).toBe('in_transit');
    expect(fs.readFileSync(placed, 'utf-8')).toBe('read and annotated by the agent');
  });

  obligation('rule-failure.ReturnedFilesPlacedIntoLiveIpcIn.3', async () => {
    // No live invocation for the recipient: the files wait, owned, and its
    // next run gets them.
    const { task, mainRun } = await mainDispatch();
    await endInvocationById(mainRun);
    await fail(task.id);
    const [back] = await ofKind('returned');
    expect(back.status).toBe('pending');
    expect((await filesOf(back.id))[0]).toMatchObject({ status: 'owned', reached_recipient: 0 });

    const next = await start('sess-main');
    expect(fs.existsSync(path.join(await ipcInOf(next), back.id, 'paper.pdf'))).toBe(true);
    expect((await transferById(back.id)).status).toBe('in_transit');
  });
});

// ── TransferPlacedIntoRunningInvocation ──────────────────────────────────────

describe('TransferPlacedIntoRunningInvocation', () => {
  obligation('rule-success.TransferPlacedIntoRunningInvocation', async () => {
    // A root task's result with a file, routed while the main container runs.
    const { task, mainRun } = await mainDispatch();
    const taskSession = (await sessionOf(task.id))!;
    const run = await start(taskSession);
    const report = stage(run, 'report.md', '# report');
    await handleDeliverSpecialistResult({ result_text: `See ${report}`, file_paths: [report] }, taskSession);

    const [result] = await ofKind('result');
    expect(result.status).toBe('in_transit');
    for (const f of await filesOf(result.id)) expect(f).toMatchObject({ status: 'placed', reached_recipient: 1 });
    expect(fs.readFileSync(path.join(await ipcInOf(mainRun), result.id, 'report.md'), 'utf-8')).toBe('# report');
  });

  obligation('rule-failure.TransferPlacedIntoRunningInvocation.1', async () => {
    // A transfer that is not pending (parked: expired) is not placed.
    await getDb().run("UPDATE sessions SET status = 'closed' WHERE id = 'sess-main'");
    const { task } = await mainDispatch();
    await fail(task.id);
    const [back] = await ofKind('returned');
    expect(back.status).toBe('expired');
    const run = (await liveMainRun())!;

    await placeTransferIntoActiveIpcIn('sess-main', back);

    expect(fs.existsSync(path.join(await ipcInOf(run), back.id))).toBe(false);
    expect((await transferById(back.id)).status).toBe('expired');
    expect((await filesOf(back.id))[0]).toMatchObject({ status: 'expired', reached_recipient: 0 });
  });
});

// ── ReturnedFilesOrphanedWithoutRecipient ────────────────────────────────────

describe('ReturnedFilesOrphanedWithoutRecipient', () => {
  obligation('rule-success.ReturnedFilesOrphanedWithoutRecipient', async () => {
    // The dispatcher's session is no longer active when its task fails: the
    // files it handed over are parked in its workspace.
    const { task, mainRun } = await mainDispatch();
    await endInvocationById(mainRun);
    await getDb().run("UPDATE sessions SET status = 'closed' WHERE id = 'sess-main'");
    await fail(task.id);

    const [given] = await ofKind('dispatch');
    const [back] = await ofKind('returned');
    expect(given.returned_as).toBe(back.id);
    expect(back.status).toBe('expired');
    const [f] = await filesOf(back.id);
    expect(f).toMatchObject({ status: 'expired', parked_path: `${ORPHANS}/${back.id}/paper.pdf` });
    expect(fs.readFileSync(parkedFile('ag-main', back.id, 'paper.pdf'), 'utf-8')).toBe('contents of paper.pdf');
    expect(fs.existsSync(path.join(TRANSFERS_BASE_DIR, back.id))).toBe(false);
  });

  obligation('rule-failure.ReturnedFilesOrphanedWithoutRecipient.1', async () => {
    // Nothing was handed back (no files): nothing to park.
    await getDb().run("UPDATE sessions SET status = 'closed' WHERE id = 'sess-main'");
    const main = await sessionRow('sess-main');
    await start(main);
    const [task] = await created(() => handleDispatchSpecialist({ specialist_group_id: 'ag-a', prompt: 'p' }, main));
    await fail(task.id);
    expect(await ofKind('returned')).toEqual([]);
    expect(fs.existsSync(path.join(GROUPS, 'ag-main', ORPHANS))).toBe(false);
  });

  obligation('rule-failure.ReturnedFilesOrphanedWithoutRecipient.2', async () => {
    // The returned transfer already reached its recipient (in_transit) when
    // the result is ready again, now with the session gone: not parked.
    const { task } = await mainDispatch();
    await fail(task.id);
    const [back] = await ofKind('returned');
    expect(back.status).toBe('in_transit');
    await getDb().run("UPDATE sessions SET status = 'closed' WHERE id = 'sess-main'");

    await routeResult((await getTask(task.id))!);

    expect((await transferById(back.id)).status).toBe('in_transit');
    expect((await filesOf(back.id))[0].parked_path ?? null).toBeNull();
  });

  obligation('rule-failure.ReturnedFilesOrphanedWithoutRecipient.3', async () => {
    // The recipient session is still active: the files wait for it.
    const { task, mainRun } = await mainDispatch();
    await endInvocationById(mainRun);
    await fail(task.id);
    const [back] = await ofKind('returned');
    expect(back.status).toBe('pending');
    expect((await filesOf(back.id))[0]).toMatchObject({ status: 'owned', parked_path: null });
  });
});

// ── ReturnedTransferEndsWithRecipientTask ────────────────────────────────────

describe('ReturnedTransferEndsWithRecipientTask', () => {
  obligation('rule-success.ReturnedTransferEndsWithRecipientTask', async () => {
    const p = await parent();
    const run = await start(p);
    // r1: a refused dispatch's file, placed into the parent's running ipc-in.
    const a = stage(run, 'a.txt');
    await handleDispatchSubTask({ specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [a] }, p);
    const [r1] = await ofKind('returned');
    expect(r1.status).toBe('in_transit');
    // r2: the files a failed child was handed, given back while the parent
    // was not awaiting it (it had crashed): waiting, pending.
    const b = stage(run, 'b.txt');
    const [child] = await created(() =>
      handleDispatchSubTask({ specialist_group_id: 'ag-b', prompt: 'p', file_paths: [b] }, p),
    );
    await getDb().run("UPDATE specialist_tasks SET status = 'awaiting_restart' WHERE id = 'task-parent'");
    await fail(child.id);
    const r2 = (await ofKind('returned')).find((t) => t.failed_task_id === child.id)!;
    expect(r2).toMatchObject({ recipient_session_id: 'sess-parent', status: 'pending' });

    // The parent ends (restarts exhausted).
    await fail('task-parent');

    // The one it read expires; the one it never received is parked in the
    // root requester's workspace.
    expect((await transferById(r1.id)).status).toBe('expired');
    expect((await filesOf(r1.id))[0]).toMatchObject({ status: 'expired', reached_recipient: 1, parked_path: null });
    expect((await transferById(r2.id)).status).toBe('expired');
    expect((await filesOf(r2.id))[0]).toMatchObject({ status: 'expired', parked_path: `${ORPHANS}/${r2.id}/b.txt` });
    expect(fs.existsSync(parkedFile('ag-main', r2.id, 'b.txt'))).toBe(true);
  });

  obligation('rule-failure.ReturnedTransferEndsWithRecipientTask.1', async () => {
    // A task with no session (a rejected sub-task) reaches terminal: the
    // files returned to its parent's session are not touched.
    const p = await parent({ depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1 });
    const run = await start(p);
    const c = stage(run, 'c.txt');
    const [rejected] = await created(() =>
      handleDispatchSubTask({ specialist_group_id: 'ag-b', prompt: 'p', file_paths: [c] }, p),
    );
    expect(rejected.status).toBe('failed');
    expect(await sessionOf(rejected.id)).toBeUndefined();
    const [back] = await ofKind('returned');
    expect(back.status).toBe('in_transit');

    await routeResult((await getTask(rejected.id))!);

    expect((await transferById(back.id)).status).toBe('in_transit');
    expect((await filesOf(back.id))[0].status).toBe('placed');
  });
});

// ── TransferParked ───────────────────────────────────────────────────────────

describe('TransferParked', () => {
  /** A sub-task's result with out.md, routed to its parent while the parent has no run: pending. */
  async function unreadSubTaskResult(): Promise<ContainerTransfer> {
    const p = await parent();
    const run = await start(p);
    const [child] = await created(() => handleDispatchSubTask({ specialist_group_id: 'ag-b', prompt: 'p' }, p));
    await endInvocationById(run);
    const childSession = (await sessionOf(child.id))!;
    const childRun = await start(childSession);
    const out = stage(childRun, 'out.md', '# out');
    await handleDeliverSpecialistResult({ result_text: `See ${out}`, file_paths: [out] }, childSession);
    const [result] = await ofKind('result');
    expect(result.status).toBe('pending');
    return result;
  }

  obligation('rule-success.TransferParked', async () => {
    // The parent ends before reading its child's result: parked in the ROOT
    // requester's workspace (the main group), not the parent's.
    const result = await unreadSubTaskResult();
    await fail('task-parent');

    expect((await transferById(result.id)).status).toBe('expired');
    const [f] = await filesOf(result.id);
    expect(f).toMatchObject({ status: 'expired', parked_path: `${ORPHANS}/${result.id}/out.md` });
    expect(fs.readFileSync(parkedFile('ag-main', result.id, 'out.md'), 'utf-8')).toBe('# out');
    expect(fs.existsSync(path.join(GROUPS, 'ag-a', ORPHANS))).toBe(false);
    expect(fs.existsSync(path.join(TRANSFERS_BASE_DIR, result.id))).toBe(false);
  });

  it('drops the files with their root requester group when that group is gone', async () => {
    const result = await unreadSubTaskResult();
    const raw = getDb();
    await raw.exec('PRAGMA foreign_keys = OFF');
    await raw.run("DELETE FROM agent_groups WHERE id = 'ag-main'");
    await raw.exec('PRAGMA foreign_keys = ON');

    await parkTransfer(result.id, 'test');

    expect((await transferById(result.id)).status).toBe('expired');
    expect((await filesOf(result.id))[0]).toMatchObject({ status: 'expired', parked_path: null });
    expect(fs.existsSync(path.join(GROUPS, 'ag-main', ORPHANS))).toBe(false);
  });

  obligation('rule-failure.TransferParked.1', async () => {
    // A transfer already retired (a completed task's dispatch transfer) is
    // not parked.
    const { task } = await mainDispatch();
    const taskSession = (await sessionOf(task.id))!;
    await start(taskSession);
    await handleDeliverSpecialistResult({ result_text: 'done' }, taskSession);
    const [given] = await ofKind('dispatch');
    expect(given.status).toBe('expired');

    await parkTransfer(given.id, 'test');

    expect((await filesOf(given.id))[0].parked_path ?? null).toBeNull();
    expect(fs.existsSync(path.join(GROUPS, 'ag-main', ORPHANS))).toBe(false);
  });
});

// ── Fields that came with returned transfers and parking ────────────────────

/** One transfer of every shape: result, dispatch (completed / failed), returned (refused / failed). */
async function everyShape(): Promise<Record<string, ContainerTransfer>> {
  const used = await mainDispatch('used.pdf');
  const usedSession = (await sessionOf(used.task.id))!;
  const usedRun = await start(usedSession);
  const report = stage(usedRun, 'report.md');
  await handleDeliverSpecialistResult({ result_text: `See ${report}`, file_paths: [report] }, usedSession);
  const failed = await mainDispatch('lost.pdf');
  await fail(failed.task.id);
  const memo = stage(used.mainRun, 'memo.txt');
  await handleDispatchSpecialist(
    { specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [memo] },
    await sessionRow('sess-main'),
  );
  const all = await transfers();
  return {
    result: all.find((t) => t.kind === 'result')!,
    usedDispatch: all.find((t) => t.kind === 'dispatch' && t.task_id === used.task.id)!,
    failedDispatch: all.find((t) => t.kind === 'dispatch' && t.task_id === failed.task.id)!,
    fromFailure: all.find((t) => t.kind === 'returned' && t.failed_task_id === failed.task.id)!,
    fromRefusal: all.find((t) => t.kind === 'returned' && t.failed_task_id == null)!,
    failedTask: { id: failed.task.id } as ContainerTransfer,
  };
}

obligation('when-presence.ContainerTransfer.returned_to', async () => {
  const s = await everyShape();
  const senderSession = async (t: ContainerTransfer) =>
    (await getDb().get<{ session_id: string }>(
      'SELECT session_id FROM invocations WHERE id = ?',
      t.sender_invocation_id,
    ))!.session_id;
  // returned: the session that named the files — the refusing caller itself,
  // or the failed task's dispatcher.
  expect(s.fromRefusal.recipient_session_id).toBe(await senderSession(s.fromRefusal));
  expect(s.fromFailure.recipient_session_id).toBe((await getTask(s.failedTask.id))!.requester_session_id);
  // Any other kind goes to someone other than the session that named the files.
  for (const t of [s.result, s.usedDispatch, s.failedDispatch]) {
    expect(t.recipient_session_id).not.toBe(await senderSession(t));
  }
});

obligation('when-presence.ContainerTransfer.failed_task', async () => {
  const s = await everyShape();
  expect(s.fromFailure.failed_task_id).toBe(s.failedTask.id);
  for (const t of [s.result, s.usedDispatch, s.failedDispatch]) expect(t.failed_task_id ?? null).toBeNull();
});

obligation('entity-optional.ContainerTransfer.failed_task', async () => {
  const s = await everyShape();
  expect(s.fromRefusal.kind).toBe('returned');
  expect(s.fromRefusal.failed_task_id).toBeNull();
  expect(s.fromFailure.failed_task_id).toBe(s.failedTask.id);
});

obligation('entity-optional.ContainerTransfer.returned_as', async () => {
  const s = await everyShape();
  expect(s.usedDispatch.status).toBe('expired');
  expect(s.usedDispatch.returned_as).toBeNull();
  expect(s.failedDispatch.returned_as).toBe(s.fromFailure.id);
});

obligation('entity-optional.TransferFile.parked_path', async () => {
  // One file read (null), one parked (set).
  const { task, mainRun } = await mainDispatch();
  const taskSession = (await sessionOf(task.id))!;
  await start(taskSession);
  await handleDeliverSpecialistResult({ result_text: 'done' }, taskSession);
  const [given] = await ofKind('dispatch');
  expect((await filesOf(given.id))[0]).toMatchObject({ status: 'expired', reached_recipient: 1, parked_path: null });

  const memo = stage(mainRun, 'memo.txt');
  await handleDispatchSpecialist(
    { specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [memo] },
    await sessionRow('sess-main'),
  );
  const [back] = await ofKind('returned');
  h.failed = [back.routed_message_id!];
  await endInvocationById(mainRun);
  expect((await filesOf(back.id))[0].parked_path).toBe(`${ORPHANS}/${back.id}/memo.txt`);
});

// ── Invariants ───────────────────────────────────────────────────────────────

async function returnedNeverCommits(step: string): Promise<void> {
  for (const t of await ofKind('returned')) {
    expect(t.commit_to_memory, `${step}: ${t.id}`).toBe(0);
    for (const f of await filesOf(t.id)) expect(f.memory_path, `${step}: ${f.id}`).toBeNull();
  }
}

obligation('invariant.ReturnedTransferNeverCommits', async () => {
  // Refused (main), refused (sub-task), failed root, failed sub-task.
  const main = await sessionRow('sess-main');
  const mainRun = await start(main);
  const memo = stage(mainRun, 'memo.txt');
  await handleDispatchSpecialist({ specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [memo] }, main);
  await returnedNeverCommits('main refused');
  const p = await parent();
  const run = await start(p);
  const a = stage(run, 'a.txt');
  await handleDispatchSubTask({ specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [a] }, p);
  await returnedNeverCommits('sub-task refused');
  const { task } = await mainDispatch();
  await fail(task.id);
  await returnedNeverCommits('root failed');
  const b = stage(run, 'b.txt');
  const [child] = await created(() =>
    handleDispatchSubTask({ specialist_group_id: 'ag-b', prompt: 'p', file_paths: [b] }, p),
  );
  await fail(child.id);
  await returnedNeverCommits('sub-task failed');
  expect((await ofKind('returned')).length).toBe(4);
});

/** NamedFilesNeverLost over every TransferFile that exists now. */
async function noneLost(step: string): Promise<void> {
  const rows = await getDb().all<{
    id: string;
    original_name: string;
    reached_recipient: number;
    memory_path: string | null;
    parked_path: string | null;
    returned_as: string | null;
  }>(
    `SELECT f.id, f.original_name, f.reached_recipient, f.memory_path, f.parked_path, t.returned_as
       FROM transfer_files f JOIN container_transfers t ON t.id = f.transfer_id
      WHERE f.status = 'expired'`,
  );
  for (const f of rows) {
    const kept = f.reached_recipient === 1 || f.memory_path != null || f.parked_path != null || f.returned_as != null;
    expect(kept, `${step}: ${f.original_name} (${f.id}) retired unseen`).toBe(true);
  }
}

obligation('invariant.NamedFilesNeverLost', async () => {
  const main = await sessionRow('sess-main');
  let mainRun = await start(main);
  const handled = async () => {
    // The main agent handles every message it has, and its container exits.
    h.acked = triggersTo('sess-main').map((w) => w.id);
    await endInvocationById(mainRun);
    await noneLost('main exit');
    mainRun = await start(main);
  };

  // 1. Accepted, the task reads its file and completes with a file of its own.
  const ok = await mainDispatch('ok.pdf');
  await noneLost('dispatched');
  const okSession = (await sessionOf(ok.task.id))!;
  const okRun = await start(okSession);
  const report = stage(okRun, 'report.md');
  await handleDeliverSpecialistResult({ result_text: `See ${report}`, file_paths: [report] }, okSession);
  await noneLost('completed');
  await handled();

  // 2. Accepted, the task fails before it starts.
  const bad = await mainDispatch('bad.pdf');
  await fail(bad.task.id);
  await noneLost('failed');
  await handled();

  // 3. Accepted, started (files in its ipc-in), then fails.
  const mid = await mainDispatch('mid.pdf');
  await start((await sessionOf(mid.task.id))!);
  await getDb().run("UPDATE specialist_tasks SET status = 'running' WHERE id = ?", mid.task.id);
  await fail(mid.task.id);
  await noneLost('failed while running');
  await handled();

  // 4. A refused main dispatch.
  const memo = stage(mainRun, 'memo.txt');
  await handleDispatchSpecialist({ specialist_group_id: 'ag-plain', prompt: 'p', file_paths: [memo] }, main);
  await noneLost('main refused');
  await handled();

  // 5. A rejected sub-task: the parent exits, reads the file in its next run, completes.
  const p = await parent({ depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1 });
  const pRun = await start(p);
  const chunk = stage(pRun, 'chunk.txt');
  await handleDispatchSubTask({ specialist_group_id: 'ag-b', prompt: 'p', file_paths: [chunk] }, p);
  await endInvocationById(pRun);
  await noneLost('parent exited');
  await start(p);
  await handleDeliverSpecialistResult({ result_text: 'done' }, p);
  await noneLost('parent completed');
  await handled();

  // 6. A main message carrying files fails: never read.
  const lost = await mainDispatch('lost.pdf');
  const lostSession = (await sessionOf(lost.task.id))!;
  const lostRun = await start(lostSession);
  const out = stage(lostRun, 'out.md');
  await handleDeliverSpecialistResult({ result_text: `See ${out}`, file_paths: [out] }, lostSession);
  const [lostResult] = (await ofKind('result')).filter((t) => t.task_id === lost.task.id);
  h.failed = [lostResult.routed_message_id!];
  await endInvocationById(mainRun);
  await noneLost('message failed');
  h.failed = [];
  mainRun = await start(main);

  // 7. An unrouted result: the main session has closed.
  const gone = await mainDispatch('gone.pdf');
  const goneSession = (await sessionOf(gone.task.id))!;
  const goneRun = await start(goneSession);
  await endInvocationById(mainRun);
  await getDb().run("UPDATE sessions SET status = 'closed' WHERE id = 'sess-main'");
  const late = stage(goneRun, 'late.md');
  await handleDeliverSpecialistResult({ result_text: `See ${late}`, file_paths: [late] }, goneSession);
  await noneLost('unrouted');

  // Every file was retired, and by more than one route.
  const open = await getDb().all("SELECT id FROM transfer_files WHERE status != 'expired'");
  expect(open).toEqual([]);
  const routes = await getDb().get<{ parked: number; reached: number; returned: number }>(
    `SELECT SUM(f.parked_path IS NOT NULL) AS parked, SUM(f.reached_recipient) AS reached,
            SUM(t.returned_as IS NOT NULL) AS returned
       FROM transfer_files f JOIN container_transfers t ON t.id = f.transfer_id`,
  );
  expect(routes!.parked).toBeGreaterThan(0);
  expect(routes!.reached).toBeGreaterThan(0);
  expect(routes!.returned).toBeGreaterThan(0);
});
