/**
 * Propagated from specs/specialists.allium — files handed over with a
 * dispatch: DispatchFilesTransferred, DispatchTransferExpiredOnTaskCompleted,
 * DispatchedFilesReturnedOnTaskFailed, the DispatchTransferNeverCommits
 * invariant, the TransferKind enum and the ContainerTransfer fields that
 * depend on it.
 *
 * Every test drives the real handlers (handleDispatchSpecialist,
 * handleDispatchSubTask, handleDeliverSpecialistResult) and the real
 * invocation lifecycle (buildInvocationForSession, endInvocationById) against
 * a migrated test DB and real temp directories, so a file is followed from
 * the dispatcher's ipc-out through host staging into the specialist's ipc-in.
 * Only the container runtime, the session mailbox writes, request-wake and
 * the null channel's presence are faked.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-spec-dispatch-files';

const h = vi.hoisted(() => ({
  writes: [] as Array<{ sessionId: string; id: string; text: string; trigger: boolean }>,
}));

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-spec-dispatch-files/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-spec-dispatch-files/groups',
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
  withExistingMailboxSession: vi.fn(async () => undefined),
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../../channels/null-channel.js', () => ({
  NULL_CHANNEL_TYPE: 'null_channel',
  NULL_CHANNEL_PLATFORM_ID: 'specialist',
  getNullMessagingGroupId: async () => 'mg-null',
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
import {
  buildInvocationForSession,
  endInvocationById,
  invocationIpcOutPath,
  TRANSFERS_BASE_DIR,
} from '../invocation.js';
import type { ContainerTransfer, SpecialistTask, TransferFile } from '../types.js';
import { obligation } from './harness.js';

const now = () => new Date().toISOString();
const IPC_OUT = SPECIALISTS_CONFIG.ipcOutContainerPath;
const IPC_IN = SPECIALISTS_CONFIG.ipcInContainerPath;
const PDF = '%PDF-1.4 ten challenges';

// ── world ────────────────────────────────────────────────────────────────────

async function group(id: string, kind: 'plain' | 'specialist' | 'memory'): Promise<void> {
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
  return (await getDb().get<Session>('SELECT * FROM sessions WHERE id = ?', id))!;
}

/** A running sub-task-capable parent: task-parent of ag-a, depth 1, with session sess-parent. */
async function parent(): Promise<Session> {
  const s = await session('sess-parent', 'ag-a', 'task-parent');
  await createTask({
    id: 'task-parent',
    specialist_group_id: 'ag-a',
    prompt: 'parent work',
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
  });
  return s;
}

/** Start a container run for `s`; returns its invocation id. */
async function start(s: Session): Promise<string> {
  const built = await buildInvocationForSession(s);
  return built!.invocationId;
}

/** Write a file into an invocation's ipc-out, as the container would. */
function stage(invocationId: string, name: string, content = PDF): string {
  fs.writeFileSync(path.join(invocationIpcOutPath(invocationId), name), content);
  return `${IPC_OUT}/${name}`;
}

const allTasks = () => getDb().all<SpecialistTask>('SELECT * FROM specialist_tasks');
const transfers = () => getDb().all<ContainerTransfer>('SELECT * FROM container_transfers ORDER BY sent_at');
const filesOf = (transferId: string) =>
  getDb().all<TransferFile>('SELECT * FROM transfer_files WHERE transfer_id = ?', transferId);
const sessionOf = (taskId: string) => getDb().get<Session>('SELECT * FROM sessions WHERE thread_id = ?', taskId);
const triggerOf = (sessionId: string) => h.writes.find((w) => w.sessionId === sessionId && w.trigger)!.text;
const ipcInOf = async (invocationId: string) =>
  ((await getDb().get('SELECT ipc_in_host_path AS p FROM invocations WHERE id = ?', invocationId)) as { p: string }).p;

/** The task created by `fn`. */
async function dispatched(fn: () => Promise<void>): Promise<SpecialistTask> {
  const before = new Set((await allTasks()).map((t) => t.id));
  await fn();
  const made = (await allTasks()).filter((t) => !before.has(t.id));
  expect(made).toHaveLength(1);
  return made[0];
}

/** Main dispatches ag-a with paper.pdf from its ipc-out. */
async function mainDispatchWithPaper(): Promise<{ task: SpecialistTask; mainInvocation: string }> {
  const main = (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'sess-main'"))!;
  const mainInvocation = await start(main);
  const pdf = stage(mainInvocation, 'paper.pdf');
  const task = await dispatched(() =>
    handleDispatchSpecialist(
      { specialist_group_id: 'ag-a', prompt: `Read ${pdf} and report.`, file_paths: [pdf] },
      main,
    ),
  );
  return { task, mainInvocation };
}

/** DispatchTransferNeverCommits, checked over every transfer that exists now. */
async function neverCommits(step: string): Promise<void> {
  for (const t of await transfers()) {
    if (t.kind !== 'dispatch') continue;
    expect(t.commit_to_memory, `${step}: ${t.id}`).toBe(0);
    expect(t.routed_message_id ?? null, `${step}: ${t.id}`).toBeNull();
    for (const f of await filesOf(t.id)) expect(f.memory_path, `${step}: ${f.id}`).toBeNull();
  }
}

beforeEach(async () => {
  h.writes.length = 0;
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
  await group('ag-main', 'plain');
  await getDb().run('UPDATE agent_groups SET is_main = 1 WHERE id = ?', 'ag-main');
  await group('ag-a', 'specialist');
  await group('ag-b', 'specialist');
  await group('ag-mem', 'memory');
  await session('sess-main', 'ag-main', null);
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── DispatchFilesTransferred ─────────────────────────────────────────────────

describe('DispatchFilesTransferred', () => {
  obligation('rule-success.DispatchFilesTransferred', async () => {
    const { task, mainInvocation } = await mainDispatchWithPaper();
    const taskSession = (await sessionOf(task.id))!;

    // One dispatch transfer for the new task, sent by the dispatcher's run,
    // addressed to the task's session, pending until that session starts.
    const [t] = await transfers();
    expect(t).toMatchObject({
      kind: 'dispatch',
      task_id: task.id,
      sender_invocation_id: mainInvocation,
      recipient_session_id: taskSession.id,
      commit_to_memory: 0,
      file_count: 1,
      status: 'pending',
    });
    // HostTookOwnership: a copy in host storage, owned.
    const [f] = await filesOf(t.id);
    expect(f).toMatchObject({ original_name: 'paper.pdf', status: 'owned', memory_path: null });
    expect(f.host_path.startsWith(TRANSFERS_BASE_DIR)).toBe(true);
    expect(fs.readFileSync(f.host_path, 'utf-8')).toBe(PDF);

    // dispatched_prompt: the path is rewritten to where the file arrives,
    // and the prompt lists it; the task records that prompt (a restart
    // re-sends it).
    const arrives = `${IPC_IN}/${t.id}/paper.pdf`;
    const prompt = triggerOf(taskSession.id);
    expect(prompt).toContain(`Read ${arrives} and report.`);
    expect(prompt).toContain(`[Files handed to you with this task`);
    expect(prompt).not.toContain(`${IPC_OUT}/paper.pdf`);
    expect((await getTask(task.id))!.prompt).toBe(prompt);

    // The task's first run finds the file in its ipc-in.
    const childInvocation = await start(taskSession);
    expect(fs.readFileSync(path.join(await ipcInOf(childInvocation), t.id, 'paper.pdf'), 'utf-8')).toBe(PDF);
    expect((await transfers())[0].status).toBe('in_transit');
    expect((await filesOf(t.id))[0].status).toBe('placed');
  });

  obligation('rule-failure.DispatchFilesTransferred.1', async () => {
    // requires: delivered.count > 0 — every listed path is refused.
    const main = (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'sess-main'"))!;
    await start(main);
    const task = await dispatched(() =>
      handleDispatchSpecialist(
        {
          specialist_group_id: 'ag-a',
          prompt: 'Read the paper.',
          file_paths: ['/workspace/agent/inbox-files/paper.pdf', `${IPC_OUT}/missing.pdf`],
        },
        main,
      ),
    );

    // No transfer, but the dispatch went ahead and both sides are told.
    expect(await transfers()).toEqual([]);
    expect(task.status).toBe('queued');
    const prompt = triggerOf((await sessionOf(task.id))!.id);
    expect(prompt).toContain('[Not delivered: /workspace/agent/inbox-files/paper.pdf (not in /workspace/ipc-out');
    expect(prompt).toContain(`${IPC_OUT}/missing.pdf (no such file)`);
    const note = h.writes.find((w) => w.sessionId === 'sess-main')!;
    expect(note.trigger).toBe(false);
    expect(note.text).toContain(task.id);
    expect(note.text).toContain('[Not delivered:');
  });

  it('hands a sub-task its files before the parent exits, and the rest are refused by name', async () => {
    const p = await parent();
    const parentInvocation = await start(p);
    const kept = stage(parentInvocation, 'chunk.txt', 'part one');
    const child = await dispatched(() =>
      handleDispatchSubTask(
        { specialist_group_id: 'ag-b', prompt: `Summarise ${kept}.`, file_paths: [kept, `${IPC_OUT}/nope.txt`] },
        p,
      ),
    );
    // The parent's container exits on dispatch: its ipc-out goes.
    await endInvocationById(parentInvocation);
    expect(fs.existsSync(invocationIpcOutPath(parentInvocation))).toBe(false);

    const [t] = await transfers();
    expect(t).toMatchObject({ kind: 'dispatch', task_id: child.id, status: 'pending' });
    const childSession = (await sessionOf(child.id))!;
    const prompt = triggerOf(childSession.id);
    expect(prompt).toContain(`Summarise ${IPC_IN}/${t.id}/chunk.txt.`);
    expect(prompt).toContain(`[Not delivered: ${IPC_OUT}/nope.txt (no such file)]`);
    // No note to the parent (a sub-task dispatch writes none).
    expect(h.writes.filter((w) => w.sessionId === 'sess-parent')).toEqual([]);

    const childInvocation = await start(childSession);
    expect(fs.readFileSync(path.join(await ipcInOf(childInvocation), t.id, 'chunk.txt'), 'utf-8')).toBe('part one');
  });

  it('hands a memory-provider lookup its files too', async () => {
    const p = await parent();
    const parentInvocation = await start(p);
    const q = stage(parentInvocation, 'query.txt', 'who?');
    const child = await dispatched(() =>
      handleDispatchSubTask({ specialist_group_id: 'ag-mem', prompt: 'Look up', file_paths: [q] }, p),
    );
    const [t] = await transfers();
    expect(t).toMatchObject({ kind: 'dispatch', task_id: child.id, status: 'pending' });
  });

  it('gives a rejected sub-task its parent files back: they survive the parent exit into its next run', async () => {
    const p = await parent();
    await getDb().run(
      'UPDATE specialist_tasks SET depth = ? WHERE id = ?',
      SPECIALISTS_CONFIG.maxSpecialistDepth - 1,
      'task-parent',
    );
    await getDb().run(
      'UPDATE specialist_tasks SET ancestor_group_ids = ? WHERE id = ?',
      JSON.stringify(Array(SPECIALISTS_CONFIG.maxSpecialistDepth - 1).fill('ag-b')),
      'task-parent',
    );
    const parentInvocation = await start(p);
    const f = stage(parentInvocation, 'chunk.txt', 'part one');
    const child = await dispatched(() =>
      handleDispatchSubTask({ specialist_group_id: 'ag-b', prompt: 'p', file_paths: [f] }, p),
    );
    expect(child.status).toBe('failed');
    // The parent's container exits on dispatch_sub_task whatever the outcome:
    // its ipc-out goes.
    await endInvocationById(parentInvocation);
    expect(fs.existsSync(invocationIpcOutPath(parentInvocation))).toBe(false);

    // The host took the file first, into a returned transfer to the parent's
    // session (no dispatch transfer: the rejected task never runs).
    const [t] = await transfers();
    expect(t).toMatchObject({
      kind: 'returned',
      task_id: null,
      failed_task_id: null,
      recipient_session_id: 'sess-parent',
      sender_invocation_id: parentInvocation,
      routed_message_id: null,
      status: 'pending',
    });
    // The rejection notice wakes the parent and names where the file now is.
    const notice = triggerOf('sess-parent');
    expect(notice).toContain('sub-task rejected: depth limit reached');
    expect(notice).toContain(`${IPC_IN}/${t.id}/chunk.txt`);

    // The parent's next run finds it in its ipc-in.
    const next = await start(p);
    expect(fs.readFileSync(path.join(await ipcInOf(next), t.id, 'chunk.txt'), 'utf-8')).toBe('part one');
    expect((await transfers())[0].status).toBe('in_transit');
    expect((await filesOf(t.id))[0]).toMatchObject({ status: 'placed', reached_recipient: 1 });
  });

  it('keeps the files with the task across a re-invocation (sub-task cycle or crash)', async () => {
    const { task } = await mainDispatchWithPaper();
    const taskSession = (await sessionOf(task.id))!;
    const first = await start(taskSession);
    await getDb().run("UPDATE specialist_tasks SET status = 'running' WHERE id = ?", task.id);
    // The run ends with the task still live: the files go back to owned.
    await endInvocationById(first);
    const [t] = await transfers();
    expect(t.status).toBe('pending');
    expect((await filesOf(t.id))[0].status).toBe('owned');
    // The next run gets them again.
    const second = await start(taskSession);
    expect(fs.readFileSync(path.join(await ipcInOf(second), t.id, 'paper.pdf'), 'utf-8')).toBe(PDF);
    expect((await transfers())[0].status).toBe('in_transit');
  });
});

// ── DispatchTransferExpiredOnTaskCompleted ───────────────────────────────────

describe('DispatchTransferExpiredOnTaskCompleted', () => {
  obligation('rule-success.DispatchTransferExpiredOnTaskCompleted', async () => {
    // Placed (in_transit), then the task delivers: expired, staging reclaimed.
    const { task } = await mainDispatchWithPaper();
    const taskSession = (await sessionOf(task.id))!;
    await start(taskSession);
    const [placed] = await transfers();
    const staging = (await filesOf(placed.id))[0].host_path;
    await handleDeliverSpecialistResult({ result_text: 'done' }, taskSession);
    expect((await getTask(task.id))!.status).toBe('completed');
    expect((await transfers()).find((t) => t.id === placed.id)!.status).toBe('expired');
    expect((await filesOf(placed.id)).map((f) => f.status)).toEqual(['expired']);
    expect(fs.existsSync(staging)).toBe(false);
    // Used up, not given back or parked.
    expect((await transfers()).find((t) => t.id === placed.id)!.returned_as ?? null).toBeNull();
    expect((await filesOf(placed.id))[0].parked_path ?? null).toBeNull();
    expect((await transfers()).filter((t) => t.kind === 'returned')).toEqual([]);

    // Still pending (never started) when the task completes: expired as well.
    const second = await mainDispatchWithPaper();
    const pending = (await transfers()).find((t) => t.task_id === second.task.id && t.kind === 'dispatch')!;
    expect(pending.status).toBe('pending');
    const { routeResult } = await import('../routing.js');
    await getDb().run(
      "UPDATE specialist_tasks SET status = 'completed', result = 'r', closed_at = ? WHERE id = ?",
      now(),
      second.task.id,
    );
    await routeResult((await getTask(second.task.id))!);
    expect((await transfers()).find((t) => t.id === pending.id)!.status).toBe('expired');
    expect((await filesOf(pending.id)).map((f) => f.status)).toEqual(['expired']);
  });
});

// ── DispatchedFilesReturnedOnTaskFailed ──────────────────────────────────────

describe('DispatchedFilesReturnedOnTaskFailed', () => {
  /** Fail `task` as the host does (timeout), and route it. */
  async function fail(task: SpecialistTask): Promise<void> {
    const { routeResult } = await import('../routing.js');
    await getDb().run(
      "UPDATE specialist_tasks SET status = 'failed', failure_kind = 'timeout', failure_detail = 'too slow', closed_at = ? WHERE id = ?",
      now(),
      task.id,
    );
    await routeResult((await getTask(task.id))!);
  }

  /** The given dispatch transfer has gone back: checks and returns the returned transfer. */
  async function givenBack(task: SpecialistTask, given: ContainerTransfer, mainIpcIn: string): Promise<void> {
    const now_ = (await transfers()).find((t) => t.id === given.id)!;
    expect(now_.status).toBe('expired');
    expect((await filesOf(given.id)).map((f) => f.status)).toEqual(['expired']);
    expect(now_.returned_as).toBeTruthy();
    const back = (await transfers()).find((t) => t.id === now_.returned_as)!;
    expect(back).toMatchObject({
      kind: 'returned',
      task_id: null,
      failed_task_id: task.id,
      recipient_session_id: 'sess-main',
      commit_to_memory: 0,
      file_count: 1,
    });
    // A copy of its own, so the dispatch's staging could go.
    const [f] = await filesOf(back.id);
    expect(f.original_name).toBe('paper.pdf');
    expect(f.host_path.startsWith(path.join(TRANSFERS_BASE_DIR, back.id))).toBe(true);
    expect(fs.existsSync(path.join(TRANSFERS_BASE_DIR, given.id))).toBe(false);
    // The main agent's container is up: placed into its live ipc-in.
    expect(back.status).toBe('in_transit');
    expect(f).toMatchObject({ status: 'placed', reached_recipient: 1 });
    expect(fs.readFileSync(path.join(mainIpcIn, back.id, 'paper.pdf'), 'utf-8')).toBe(PDF);
    // The failure message names where the files are now, and its handling
    // is what retires the returned transfer.
    const failure = h.writes.find(
      (w) => w.sessionId === 'sess-main' && w.trigger && w.text.startsWith('Specialist task failed: timeout'),
    )!;
    expect(failure.text).toContain(`${IPC_IN}/${back.id}/paper.pdf`);
    expect(back.routed_message_id).toBe(failure.id);
  }

  obligation('rule-success.DispatchedFilesReturnedOnTaskFailed', async () => {
    // The task never started: its dispatch transfer is still pending.
    const { task, mainInvocation } = await mainDispatchWithPaper();
    const given = (await transfers()).find((t) => t.kind === 'dispatch')!;
    expect(given.status).toBe('pending');
    await fail(task);
    await givenBack(task, given, await ipcInOf(mainInvocation));
  });

  it('gives back files the task had already been handed in a running container (in_transit)', async () => {
    const { task, mainInvocation } = await mainDispatchWithPaper();
    const taskSession = (await sessionOf(task.id))!;
    await start(taskSession);
    await getDb().run("UPDATE specialist_tasks SET status = 'running' WHERE id = ?", task.id);
    const given = (await transfers()).find((t) => t.kind === 'dispatch')!;
    expect(given.status).toBe('in_transit');
    // routeResult ends the task's run first (InvocationEndedOnTaskTerminal);
    // the files must still be there to give back.
    await fail(task);
    await givenBack(task, given, await ipcInOf(mainInvocation));
  });
});

// ── DispatchTransferNeverCommits ─────────────────────────────────────────────

obligation('invariant.DispatchTransferNeverCommits', async () => {
  // A whole life: dispatch, placement, a run ending live, a re-run, and a
  // delivery that itself asks to commit to memory.
  const { task } = await mainDispatchWithPaper();
  await neverCommits('dispatched');
  const taskSession = (await sessionOf(task.id))!;
  const first = await start(taskSession);
  await neverCommits('placed');
  await getDb().run("UPDATE specialist_tasks SET status = 'running' WHERE id = ?", task.id);
  await endInvocationById(first);
  await neverCommits('reset');
  const second = await start(taskSession);
  await neverCommits('re-placed');
  const report = stage(second, 'report.md', '# report');
  await handleDeliverSpecialistResult(
    { result_text: `See ${report}`, file_paths: [report], commit_to_memory: true },
    taskSession,
  );
  await neverCommits('delivered');
  // The delivery's own transfer did commit; the dispatch one did not.
  const kinds = (await transfers()).map((t) => [t.kind, t.commit_to_memory]);
  expect(kinds).toEqual(
    expect.arrayContaining([
      ['dispatch', 0],
      ['result', 1],
    ]),
  );
});

// ── TransferKind and the ContainerTransfer fields that depend on it ─────────

/** One transfer of each kind: the dispatch above, and the delivery that answers it. */
async function bothKinds(): Promise<{ dispatch: ContainerTransfer; result: ContainerTransfer; task: SpecialistTask }> {
  const { task } = await mainDispatchWithPaper();
  const taskSession = (await sessionOf(task.id))!;
  const run = await start(taskSession);
  const report = stage(run, 'report.md', '# report');
  await handleDeliverSpecialistResult({ result_text: `See ${report}`, file_paths: [report] }, taskSession);
  const all = await transfers();
  return {
    dispatch: all.find((t) => t.kind === 'dispatch')!,
    result: all.find((t) => t.kind === 'result')!,
    task,
  };
}

obligation('enum-comparable.TransferKind', async () => {
  const { dispatch, result } = await bothKinds();
  // And a refused dispatch, whose file comes back as a returned transfer.
  const main = (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'sess-main'"))!;
  const mainRun = await start(main);
  const memo = stage(mainRun, 'memo.txt', 'memo');
  await handleDispatchSpecialist({ specialist_group_id: 'ag-main', prompt: 'p', file_paths: [memo] }, main);
  const rows = await transfers();
  expect(new Set(rows.map((t) => t.kind))).toEqual(new Set(['result', 'dispatch', 'returned']));
  const returned = rows.find((t) => t.kind === 'returned')!;
  // Comparable: selecting by kind partitions the transfers.
  const byKind = async (k: string) =>
    (await getDb().all<{ id: string }>('SELECT id FROM container_transfers WHERE kind = ?', k)).map((r) => r.id);
  expect(await byKind('dispatch')).toEqual([dispatch.id]);
  expect(await byKind('result')).toEqual([result.id]);
  expect(await byKind('returned')).toEqual([returned.id]);
  // Every row written before the column is a result.
  const col = (
    await getDb().all<{ name: string; dflt_value: string | null }>(
      "SELECT name, dflt_value FROM pragma_table_info('container_transfers')",
    )
  ).find((c) => c.name === 'kind')!;
  expect(col.dflt_value).toBe("'result'");
});

// The store keeps one task_id column: for a result it is the delivering task
// (ContainerTransfer.task), for a dispatch the task the files go to
// (ContainerTransfer.dispatched_task). result_text is NOT NULL in the store;
// a dispatch transfer leaves it empty.

obligation('when-presence.ContainerTransfer.task', async () => {
  const { dispatch, result, task } = await bothKinds();
  // result: task_id is the delivering task, whose own run sent it.
  expect(result.task_id).toBe(task.id);
  const sender = (await getDb().get<{ session_id: string }>(
    'SELECT session_id FROM invocations WHERE id = ?',
    result.sender_invocation_id,
  ))!;
  expect(sender.session_id).toBe((await sessionOf(task.id))!.id);
  // dispatch: there is no delivering task — it was sent by the main agent's run.
  const dispatcher = (await getDb().get<{ session_id: string; task_id: string | null }>(
    'SELECT session_id, task_id FROM invocations WHERE id = ?',
    dispatch.sender_invocation_id,
  ))!;
  expect(dispatcher).toEqual({ session_id: 'sess-main', task_id: null });
});

obligation('when-presence.ContainerTransfer.dispatched_task', async () => {
  const { dispatch, result, task } = await bothKinds();
  // dispatch: task_id is the dispatched task, and its session the recipient from the start.
  expect(dispatch.task_id).toBe(task.id);
  expect(dispatch.recipient_session_id).toBe((await sessionOf(task.id))!.id);
  // result: no dispatched task — its recipient is the requester, found at routing.
  expect(result.recipient_session_id).toBe('sess-main');
});

obligation('when-presence.ContainerTransfer.result_text', async () => {
  const { dispatch, result } = await bothKinds();
  expect(result.result_text).toContain(`${IPC_IN}/${result.id}/report.md`);
  expect(dispatch.result_text).toBe('');
});
