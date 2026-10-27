/**
 * Results & routing obligations propagated from specs/specialists.allium:
 * SpecialistDeliveredResult, TransferFilesOwned, SpecialistResultRoutedToMain,
 * SpecialistResultRoutedToParent, SpecialistFailureRoutedToRequester,
 * SpecialistTaskTimedOut, SpecialistTaskCompletedTerminal,
 * SpecialistTaskFailedTerminal, SpecialistTaskSessionClosed,
 * UnroutedTransferExpired.
 *
 * The real delivery, routing, invocation and recovery code runs against a
 * real central DB and a real (temporary) DATA_DIR / GROUPS_DIR. Only the
 * process boundaries are faked: container-runner (wake/kill), the session
 * mailbox writes (captured, so routed messages can be asserted) and the
 * boot-crash state the sweep consults.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-spec-results/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-spec-results/groups',
  };
});
vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  registerSessionExitHook: vi.fn(),
}));
// Every session has a (fake) mailbox: closing a specialist session fails its
// pending inbound messages through it, which is what is recorded here.
const mailbox = vi.hoisted(() => ({ failed: [] as Array<[string, string]> }));
vi.mock('../../../session-manager.js', () => ({
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(),
  withExistingMailboxSession: vi.fn(async (agentGroupId: string, sessionId: string, action: (m: unknown) => unknown) =>
    action({
      failPendingMessages: () => mailbox.failed.push([agentGroupId, sessionId]),
      countDueMessages: () => 0,
      getProcessingClaims: () => [],
      getTerminalProcessingAcks: () => [],
      getMessageForRetry: () => undefined,
    }),
  ),
}));
vi.mock('../../boot-crash/index.js', () => ({
  getBootCrashState: vi.fn().mockReturnValue({ count: 0, stderrTail: [] }),
  clearBootCrashState: vi.fn(),
  registerBootCrashExemption: vi.fn(),
}));

import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createSession, getSession } from '../../../db/sessions.js';
import { isContainerRunning, killContainer, wakeContainer } from '../../../container-runner.js';
import { writeSessionMessage } from '../../../session-manager.js';
import { SPECIALISTS_CONFIG } from '../config.js';
import { createSpecialist, createTask, getTask } from '../db.js';
import { handleDeliverSpecialistResult } from '../delivery.js';
import { buildInvocationForSession, hostStagingPath, TRANSFERS_BASE_DIR } from '../invocation.js';
import { sweepSpecialistTasks } from '../recovery.js';
import { routeResult } from '../routing.js';
import type { ContainerTransfer, SpecialistTask, TransferFile } from '../types.js';
import { divergence, obligation } from './harness.js';

const ROOT = '/tmp/nanoclaw-test-spec-results';
const DATA = path.join(ROOT, 'data');
const GROUPS = path.join(ROOT, 'groups');
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
  vi.mocked(isContainerRunning).mockReturnValue(false);
  mailbox.failed.length = 0;
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── fixture ──────────────────────────────────────────────────────────────────

/** Main group ag-main (session sess-main), specialists ag-spec and ag-sub. */
async function world(opts: { mainStatus?: 'active' | 'closed'; subParentNotice?: string } = {}): Promise<void> {
  for (const [id, folder] of [
    ['ag-main', 'main'],
    ['ag-spec', 'spec'],
    ['ag-sub', 'sub'],
  ]) {
    await createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: now() });
  }
  await createSpecialist({
    agent_group_id: 'ag-spec',
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
  await createSpecialist({
    agent_group_id: 'ag-sub',
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: opts.subParentNotice ?? null,
    created_at: now(),
  });
  await session('sess-main', 'ag-main', null, opts.mainStatus ?? 'active');
}

async function session(
  id: string,
  group: string,
  thread: string | null,
  status: 'active' | 'closed' = 'active',
): Promise<void> {
  await createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: thread,
    agent_provider: null,
    status,
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });
}

function taskRow(over: Partial<SpecialistTask> & Pick<SpecialistTask, 'id'>): SpecialistTask {
  return {
    specialist_group_id: 'ag-spec',
    prompt: 'do work',
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
}

/** A root task task-root dispatched by the main group, with its session sess-root. */
async function rootTask(
  over: Partial<SpecialistTask> = {},
  sessionStatus: 'active' | 'closed' = 'active',
): Promise<SpecialistTask> {
  const t = taskRow({ id: 'task-root', ...over });
  await createTask(t);
  await session('sess-root', t.specialist_group_id, t.id, sessionStatus);
  return t;
}

/**
 * task-parent (ag-spec, session sess-parent) dispatched task-child (ag-sub,
 * session sess-child) and, by default, awaits it.
 */
async function parentAndChild(
  opts: {
    parentStatus?: SpecialistTask['status'];
    parentSessionStatus?: 'active' | 'closed';
    childLast?: boolean;
    childDispatchedAt?: string;
  } = {},
): Promise<void> {
  const parentStatus = opts.parentStatus ?? 'awaiting_sub_task';
  await createTask(
    taskRow({
      id: 'task-parent',
      status: parentStatus,
    }),
  );
  await session('sess-parent', 'ag-spec', 'task-parent', opts.parentSessionStatus ?? 'active');
  await createTask(
    taskRow({
      id: 'task-child',
      specialist_group_id: 'ag-sub',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      depth: 1,
      chain_delegation_count: 2,
      ancestor_group_ids: '["ag-spec"]',
      is_last_same_type_dispatch: opts.childLast ? 1 : 0,
      dispatched_at: opts.childDispatchedAt ?? now(),
    }),
  );
  await session('sess-child', 'ag-sub', 'task-child');
  if (parentStatus === 'awaiting_sub_task') await pointAt('task-parent', 'task-child');
}

/** Start a real invocation for the session and put files in its ipc-out. */
/** Set a parent's pending_sub_task once the child row exists (the FK needs it). */
async function pointAt(parentId: string, childId: string): Promise<void> {
  await getDb().run('UPDATE specialist_tasks SET pending_sub_task_id = ? WHERE id = ?', childId, parentId);
}

/** An ended invocation row, for transfers set up directly. */
async function endedInvocation(id: string, sessionId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at, ended_at)
     VALUES (?, ?, NULL, '/x/out', '/x/in', ?, ?)`,
    id,
    sessionId,
    now(),
    now(),
  );
}

async function startInvocation(sessionId: string, files: Record<string, string> = {}): Promise<string> {
  const built = await buildInvocationForSession((await getSession(sessionId))!);
  const inv = (await getDb().get('SELECT * FROM invocations WHERE id = ?', built!.invocationId)) as {
    id: string;
    ipc_out_host_path: string;
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(inv.ipc_out_host_path, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return inv.id;
}

async function deliver(sessionId: string, content: Record<string, unknown>): Promise<void> {
  await handleDeliverSpecialistResult(content, (await getSession(sessionId))!);
}

interface Sent {
  id: string;
  kind: string;
  trigger: unknown;
  processAfter?: unknown;
  body: { text: string; completedSpecialistTaskId?: string };
}

function messagesTo(sessionId: string): Sent[] {
  return vi
    .mocked(writeSessionMessage)
    .mock.calls.filter(([, s]) => s === sessionId)
    .map(([, , m]) => {
      const msg = m as unknown as Omit<Sent, 'body'> & { content: string };
      return { ...msg, body: JSON.parse(msg.content) };
    });
}

function woken(sessionId: string): boolean {
  return vi.mocked(wakeContainer).mock.calls.some(([s]) => s.id === sessionId);
}

async function transfersOf(taskId: string): Promise<ContainerTransfer[]> {
  return (await getDb().all('SELECT * FROM container_transfers WHERE task_id = ?', taskId)) as ContainerTransfer[];
}

async function filesOf(transferId: string): Promise<TransferFile[]> {
  return (await getDb().all(
    'SELECT * FROM transfer_files WHERE transfer_id = ? ORDER BY original_name',
    transferId,
  )) as TransferFile[];
}

function expectBetween(iso: string | null | undefined, before: string): void {
  expect(iso).toBeTruthy();
  expect(Date.parse(iso!)).toBeGreaterThanOrEqual(Date.parse(before));
  expect(Date.parse(iso!)).toBeLessThanOrEqual(Date.now());
}

async function mountStatuses(invocationId: string): Promise<{ out: string; in_: string; ended: boolean }> {
  const db = getDb();
  const out = (await db.get('SELECT status FROM ipc_out_mounts WHERE invocation_id = ?', invocationId)) as {
    status: string;
  };
  const in_ = (await db.get('SELECT status FROM ipc_in_mounts WHERE invocation_id = ?', invocationId)) as {
    status: string;
  };
  const inv = (await db.get('SELECT ended_at FROM invocations WHERE id = ?', invocationId)) as {
    ended_at: string | null;
  };
  return { out: out.status, in_: in_.status, ended: inv.ended_at != null };
}

// ── SpecialistDeliveredResult ────────────────────────────────────────────────

describe('SpecialistDeliveredResult', () => {
  obligation('rule-success.SpecialistDeliveredResult', async () => {
    await world();
    await rootTask();
    const invocationId = await startInvocation('sess-root', { 'report.md': 'the report' });
    const before = now();

    await deliver('sess-root', {
      result_text: 'See /workspace/ipc-out/report.md',
      file_paths: ['/workspace/ipc-out/report.md'],
    });

    const task = (await getTask('task-root'))!;
    expect(task.status).toBe('completed');
    expectBetween(task.closed_at, before);

    const [transfer] = await transfersOf('task-root');
    // resolved_text: ipc-out paths rewritten to the requester's ipc-in view.
    expect(transfer.result_text).toBe(`See /workspace/ipc-in/${transfer.id}/report.md`);
    expect(task.result).toBe(transfer.result_text);
    expect(transfer).toMatchObject({
      sender_invocation_id: invocationId,
      commit_to_memory: 0,
      file_count: 1,
      status: 'pending',
    });
    expectBetween(transfer.sent_at, before);

    // SpecialistResultReady: the result reaches the requester.
    expect(messagesTo('sess-main').map((m) => m.body.text)).toEqual([task.result]);
  });

  obligation('rule-failure.SpecialistDeliveredResult.1', async () => {
    // No live task for the delivering session: a late, repeated delivery
    // from a session whose task already completed.
    await world();
    await rootTask({ status: 'completed', result: 'the first answer', closed_at: ago(1000) });
    await startInvocation('sess-root', { 'report.md': 'late' });

    await deliver('sess-root', { result_text: 'a second answer', file_paths: ['report.md'] });

    const task = (await getTask('task-root'))!;
    expect(task.status).toBe('completed');
    expect(task.result).toBe('the first answer');
    expect(await transfersOf('task-root')).toEqual([]);
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  obligation('rule-failure.SpecialistDeliveredResult.2', async () => {
    // A live task that is not running (it is waiting on its own sub-task).
    // queued / awaiting_restart are advanced to running by the delivery
    // itself (SpecialistContainerProcessing), so this is the live status for
    // which the requires is false.
    await world();
    await rootTask({ status: 'awaiting_sub_task' });
    await createTask(
      taskRow({
        id: 'task-sub',
        specialist_group_id: 'ag-sub',
        requester_group_id: null,
        requester_task_id: 'task-root',
        requester_session_id: 'sess-root',
        depth: 1,
      }),
    );
    await pointAt('task-root', 'task-sub');
    await startInvocation('sess-root', { 'report.md': 'early' });

    await deliver('sess-root', { result_text: 'too early', file_paths: ['report.md'] });

    const task = (await getTask('task-root'))!;
    expect(task.status).toBe('awaiting_sub_task');
    expect(task.result).toBeNull();
    expect(task.closed_at).toBeNull();
    expect(await transfersOf('task-root')).toEqual([]);
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect((await getSession('sess-root'))!.status).toBe('active');
  });
});

// ── TransferFilesOwned ───────────────────────────────────────────────────────

describe('TransferFilesOwned', () => {
  obligation('rule-success.TransferFilesOwned', async () => {
    // A path listed twice (two spellings) is one file; two files of one
    // name both arrive, the second numbered before its extension.
    await world();
    await rootTask();
    await startInvocation('sess-root', { 'report.md': 'A', 'sub/report.md': 'B', 'notes.txt': 'C' });

    await deliver('sess-root', {
      result_text: 'Read report.md, then /workspace/ipc-out/sub/report.md and notes.txt',
      file_paths: ['/workspace/ipc-out/report.md', 'report.md', '/workspace/ipc-out/sub/report.md', 'notes.txt'],
    });

    const [transfer] = await transfersOf('task-root');
    expect(transfer.file_count).toBe(3);
    const files = await filesOf(transfer.id);
    expect(files.map((f) => [f.original_name, f.status, f.memory_path, fs.readFileSync(f.host_path, 'utf-8')])).toEqual(
      [
        ['notes.txt', 'owned', null, 'C'],
        ['report-2.md', 'owned', null, 'B'],
        ['report.md', 'owned', null, 'A'],
      ],
    );
    const at = `/workspace/ipc-in/${transfer.id}`;
    expect(transfer.result_text).toBe(`Read ${at}/report.md, then ${at}/report-2.md and ${at}/notes.txt`);
  });

  obligation('rule-entity-creation.TransferFilesOwned.1', async () => {
    await world();
    await rootTask();
    await startInvocation('sess-root', { 'data/table.csv': 'a,b\n1,2' });

    await deliver('sess-root', { result_text: 'table attached', file_paths: ['/workspace/ipc-out/data/table.csv'] });

    const [transfer] = await transfersOf('task-root');
    const files = await filesOf(transfer.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      transfer_id: transfer.id,
      original_name: 'table.csv',
      host_path: hostStagingPath(transfer.id, 'table.csv'),
      status: 'owned',
      memory_path: null,
    });
    // Ownership passes by copy into host-managed storage.
    expect(fs.readFileSync(files[0].host_path, 'utf-8')).toBe('a,b\n1,2');
  });
});

// ── SpecialistResultRoutedToMain ─────────────────────────────────────────────

/** Deliver a root result with commit_to_memory and return what routing did. */
async function commitDelivery(): Promise<{ task: SpecialistTask; transfer: ContainerTransfer; sent: Sent[] }> {
  await rootTask();
  await startInvocation('sess-root', { 'report.md': 'the report', 'sub/report.md': 'the other report' });
  await deliver('sess-root', {
    result_text: 'See /workspace/ipc-out/report.md and sub/report.md',
    file_paths: ['/workspace/ipc-out/report.md', 'sub/report.md'],
    commit_to_memory: true,
  });
  const [transfer] = await transfersOf('task-root');
  return { task: (await getTask('task-root'))!, transfer, sent: messagesTo('sess-main') };
}

async function expectCommitted(task: SpecialistTask, transfer: ContainerTransfer, sent: Sent[]): Promise<void> {
  const reports = path.join(GROUPS, 'main', 'zettel', 'reports');
  expect(fs.readFileSync(path.join(reports, 'report.md'), 'utf-8')).toBe('the report');
  expect(fs.readFileSync(path.join(reports, 'report-2.md'), 'utf-8')).toBe('the other report');
  expect((await filesOf(transfer.id)).map((f) => [f.original_name, f.memory_path])).toEqual([
    ['report-2.md', 'zettel/reports/report-2.md'],
    ['report.md', 'zettel/reports/report.md'],
  ]);
  // In the order the files were listed.
  expect(JSON.parse(task.committed_files!)).toEqual(['zettel/reports/report.md', 'zettel/reports/report-2.md']);
  // committed is transient: the commit path ends the transfer expired.
  expect(transfer.status).toBe('expired');

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ kind: 'chat', trigger: true });
  expect(sent[0].processAfter).toBeUndefined();
  expect(sent[0].body.text).toBe('See zettel/reports/report.md and zettel/reports/report-2.md');
  expect(woken('sess-main')).toBe(true);
}

describe('SpecialistResultRoutedToMain', () => {
  divergence(
    'rule-success.SpecialistResultRoutedToMain',
    'routing.ts routeResultToMain records routed_message_id only in the staged (commit_to_memory = false) branch (~line 170); a committed transfer never gets transfer.routed_message',
    async () => {
      await world();
      const { task, transfer, sent } = await commitDelivery();

      await expectCommitted(task, transfer, sent);
      // if exists transfer: transfer.routed_message = message
      expect(transfer.routed_message_id).toBe(sent[0].id);
    },
  );

  // The rest of the success obligation, which the code meets, kept guarded
  // while the divergence above stands.
  it('SpecialistResultRoutedToMain commits files and routes the message (all but the routed_message link)', async () => {
    await world();
    const { task, transfer, sent } = await commitDelivery();
    await expectCommitted(task, transfer, sent);
  });

  it('SpecialistResultRoutedToMain records the routed message on a staged transfer', async () => {
    await world();
    await rootTask();
    await startInvocation('sess-root', { 'report.md': 'r' });
    await deliver('sess-root', { result_text: 'report.md', file_paths: ['report.md'] });
    const [transfer] = await transfersOf('task-root');
    const [sent] = messagesTo('sess-main');
    expect(transfer.routed_message_id).toBe(sent.id);
    expect(transfer.recipient_session_id).toBe('sess-main');
  });

  obligation('rule-failure.SpecialistResultRoutedToMain.1', async () => {
    // A sub-task (requester_group = null) whose requester_session is an
    // active main session: it is not routed to main. (Its parent is not
    // awaiting it, so nothing routes it to a parent either.)
    await world();
    await parentAndChild({ parentStatus: 'running' });
    await getDb().run("UPDATE specialist_tasks SET requester_session_id = 'sess-main' WHERE id = 'task-child'");

    await deliver('sess-child', { result_text: 'child answer' });

    expect((await getTask('task-child'))!.status).toBe('completed');
    expect(messagesTo('sess-main')).toEqual([]);
    expect(woken('sess-main')).toBe(false);
  });

  obligation('rule-failure.SpecialistResultRoutedToMain.2', async () => {
    // The main session is closed: no commit, no message, no wake.
    await world({ mainStatus: 'closed' });
    const { task } = await commitDelivery();

    expect(task.status).toBe('completed');
    expect(task.committed_files).toBeNull();
    expect(fs.existsSync(path.join(GROUPS, 'main', 'zettel', 'reports', 'report.md'))).toBe(false);
    expect(messagesTo('sess-main')).toEqual([]);
    expect(woken('sess-main')).toBe(false);
  });
});

// ── SpecialistResultRoutedToParent ───────────────────────────────────────────

describe('SpecialistResultRoutedToParent', () => {
  obligation('rule-success.SpecialistResultRoutedToParent', async () => {
    await world();
    await parentAndChild();
    await startInvocation('sess-child', { 'report.md': 'found' });

    // commit_to_memory on a sub-task degrades to staging into the parent's ipc-in.
    await deliver('sess-child', {
      result_text: 'Found it: /workspace/ipc-out/report.md',
      file_paths: ['/workspace/ipc-out/report.md'],
      commit_to_memory: true,
    });

    const parent = (await getTask('task-parent'))!;
    expect(parent.status).toBe('running');
    expect(parent.pending_sub_task_id).toBeNull();

    const [transfer] = await transfersOf('task-child');
    expect(transfer.commit_to_memory).toBe(0);
    expect(transfer.recipient_session_id).toBe('sess-parent');
    const sent = messagesTo('sess-parent');
    expect(sent.map((m) => m.body.text)).toEqual([`Found it: /workspace/ipc-in/${transfer.id}/report.md`]);
    expect(woken('sess-parent')).toBe(true);
    expect(messagesTo('sess-main')).toEqual([]);
  });

  obligation('rule-failure.SpecialistResultRoutedToParent.1', async () => {
    // A root task (requester_task = null) is not routed to a parent, even one
    // whose pending_sub_task points at it.
    await world();
    await createTask(taskRow({ id: 'task-parent', status: 'awaiting_sub_task' }));
    await session('sess-parent', 'ag-spec', 'task-parent');
    await rootTask({ specialist_group_id: 'ag-sub' });
    await pointAt('task-parent', 'task-root');

    await deliver('sess-root', { result_text: 'root answer' });

    const parent = (await getTask('task-parent'))!;
    expect(parent.status).toBe('awaiting_sub_task');
    expect(parent.pending_sub_task_id).toBe('task-root');
    expect(messagesTo('sess-parent')).toEqual([]);
    expect(woken('sess-parent')).toBe(false);
  });

  obligation('rule-failure.SpecialistResultRoutedToParent.2', async () => {
    // The parent is not awaiting a sub-task.
    await world();
    await parentAndChild({ parentStatus: 'running' });

    await deliver('sess-child', { result_text: 'child answer' });

    expect((await getTask('task-child'))!.status).toBe('completed');
    expect((await getTask('task-parent'))!.status).toBe('running');
    expect(messagesTo('sess-parent')).toEqual([]);
    expect(woken('sess-parent')).toBe(false);
  });

  obligation('rule-failure.SpecialistResultRoutedToParent.3', async () => {
    // The parent's session is not active.
    await world();
    await parentAndChild({ parentSessionStatus: 'closed' });

    await deliver('sess-child', { result_text: 'child answer' });

    expect((await getTask('task-child'))!.status).toBe('completed');
    const parent = (await getTask('task-parent'))!;
    expect(parent.status).toBe('awaiting_sub_task');
    expect(parent.pending_sub_task_id).toBe('task-child');
    expect(messagesTo('sess-parent')).toEqual([]);
    expect(woken('sess-parent')).toBe(false);
  });

  obligation('rule-entity-creation.SpecialistResultRoutedToParent.1', async () => {
    // The created InboundMessage: on the parent session, chat, triggering,
    // not deferred, carrying routed_message_text — the child's result plus
    // the specialist's own last-turn parent notice for a last dispatch —
    // and the child's id for correlation.
    await world({ subParentNotice: '[ag-sub has nothing further.]' });
    await parentAndChild({ childLast: true });

    await deliver('sess-child', { result_text: 'the answer' });

    const sent = messagesTo('sess-parent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'chat', trigger: true });
    expect(sent[0].processAfter).toBeUndefined();
    expect(sent[0].body.text).toBe('the answer\n\n[ag-sub has nothing further.]');
    expect(sent[0].body.completedSpecialistTaskId).toBe('task-child');
  });
});

// ── SpecialistFailureRoutedToRequester / SpecialistTaskTimedOut ──────────────

describe('failure routing', () => {
  obligation('rule-success.SpecialistFailureRoutedToRequester', async () => {
    // A sub-task fails (here by timing out in the sweep); its failure reaches
    // the waiting parent as "Specialist task failed: <kind> — <detail>" with
    // the post-mortem read from the specialist's run log.
    const saved = SPECIALISTS_CONFIG.maxTaskDurationMs;
    SPECIALISTS_CONFIG.maxTaskDurationMs = 60_000;
    try {
      await world();
      await parentAndChild({ childDispatchedAt: ago(120_000) });
      const logs = path.join(DATA, 'v2-sessions', 'ag-sub', 'sess-child', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, '2026-10-27T10-00-00-000Z-runner-7.log'), 'boot\nstderr fetch hung\n');

      await sweepSpecialistTasks();

      expect((await getTask('task-child'))!.status).toBe('failed');
      const parent = (await getTask('task-parent'))!;
      expect(parent.status).toBe('running');
      expect(parent.pending_sub_task_id).toBeNull();
      expect(messagesTo('sess-parent').map((m) => m.body.text)).toEqual([
        'Specialist task failed: timeout — task exceeded maximum duration\n\n' +
          'What the specialist was doing:\n• Last log line: stderr fetch hung',
      ]);
      expect(woken('sess-parent')).toBe(true);
    } finally {
      SPECIALISTS_CONFIG.maxTaskDurationMs = saved;
    }
  });

  obligation('rule-success.SpecialistTaskTimedOut', async () => {
    await world();
    await rootTask({ dispatched_at: ago(SPECIALISTS_CONFIG.maxTaskDurationMs + 1000) });
    const before = now();

    await sweepSpecialistTasks();

    const task = (await getTask('task-root'))!;
    expect(task.status).toBe('failed');
    expect(task.failure_kind).toBe('timeout');
    expect(task.failure_detail).toBe('task exceeded maximum duration');
    expectBetween(task.closed_at, before);
    expect(messagesTo('sess-main').map((m) => m.body.text)).toEqual([
      'Specialist task failed: timeout — task exceeded maximum duration',
    ]);
  });

  obligation('rule-failure.SpecialistTaskTimedOut.1', async () => {
    // Long past max_task_duration, but already terminal.
    await world();
    await rootTask({
      status: 'completed',
      result: 'done in time',
      closed_at: ago(SPECIALISTS_CONFIG.maxTaskDurationMs),
      dispatched_at: ago(SPECIALISTS_CONFIG.maxTaskDurationMs + 60_000),
    });

    await sweepSpecialistTasks();

    const task = (await getTask('task-root'))!;
    expect(task.status).toBe('completed');
    expect(task.failure_kind).toBeNull();
    expect(task.result).toBe('done in time');
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });
});

// ── terminal transitions: invocation end + session close ─────────────────────

describe('SpecialistTaskReachedTerminal', () => {
  obligation('rule-success.SpecialistTaskCompletedTerminal', async () => {
    await world();
    await rootTask();
    const invocationId = await startInvocation('sess-root');
    expect(await mountStatuses(invocationId)).toEqual({ out: 'active', in_: 'active', ended: false });

    await deliver('sess-root', { result_text: 'done' });

    expect(await mountStatuses(invocationId)).toEqual({ out: 'cleared', in_: 'cleared', ended: true });
    expect((await getSession('sess-root'))!.status).toBe('closed');
  });

  obligation('rule-success.SpecialistTaskFailedTerminal', async () => {
    await world();
    await rootTask({ dispatched_at: ago(SPECIALISTS_CONFIG.maxTaskDurationMs + 1000) });
    const invocationId = await startInvocation('sess-root');

    await sweepSpecialistTasks();

    expect((await getTask('task-root'))!.status).toBe('failed');
    expect(await mountStatuses(invocationId)).toEqual({ out: 'cleared', in_: 'cleared', ended: true });
    expect((await getSession('sess-root'))!.status).toBe('closed');
  });

  obligation('rule-success.SpecialistTaskSessionClosed', async () => {
    await world();
    await rootTask();
    vi.mocked(isContainerRunning).mockReturnValue(true);

    await deliver('sess-root', { result_text: 'done' });

    expect((await getSession('sess-root'))!.status).toBe('closed');
    // Its still-pending inbound messages are failed, its container stopped.
    expect(mailbox.failed).toEqual([['ag-spec', 'sess-root']]);
    expect(killContainer).toHaveBeenCalledWith('sess-root', 'task-complete');
    // The requester's session is not the task's session.
    expect((await getSession('sess-main'))!.status).toBe('active');
  });

  obligation('rule-failure.SpecialistTaskSessionClosed.1', async () => {
    // A sub-task rejected at dispatch is created failed with no session.
    // Its group has another task's live session, which must be left alone.
    await world();
    await parentAndChild({ parentStatus: 'running' });
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const rejected = taskRow({
      id: 'task-rejected',
      specialist_group_id: 'ag-sub',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      depth: 1,
      status: 'failed',
      failure_kind: 'depth_exceeded',
      failure_detail: 'too deep',
      closed_at: now(),
    });
    await createTask(rejected);

    await routeResult(rejected);

    expect((await getSession('sess-child'))!.status).toBe('active');
    expect((await getSession('sess-parent'))!.status).toBe('active');
    expect(mailbox.failed).toEqual([]);
    expect(killContainer).not.toHaveBeenCalled();
  });

  obligation('rule-failure.SpecialistTaskSessionClosed.2', async () => {
    // The task's session is already closed (e.g. by an admin): closing is a
    // no-op — its messages are not failed again, no container is stopped.
    await world();
    await rootTask({}, 'closed');
    vi.mocked(isContainerRunning).mockReturnValue(true);

    await deliver('sess-root', { result_text: 'done' });

    expect((await getTask('task-root'))!.status).toBe('completed');
    expect((await getSession('sess-root'))!.status).toBe('closed');
    expect(mailbox.failed).toEqual([]);
    expect(killContainer).not.toHaveBeenCalled();
  });
});

// ── UnroutedTransferExpired ──────────────────────────────────────────────────

describe('UnroutedTransferExpired', () => {
  obligation('rule-success.UnroutedTransferExpired', async () => {
    // A root result with files whose main session is closed: no recipient.
    await world({ mainStatus: 'closed' });
    await rootTask();
    await startInvocation('sess-root', { 'report.md': 'r', 'b.md': 'b' });

    await deliver('sess-root', { result_text: 'files', file_paths: ['report.md', 'b.md'] });

    const [transfer] = await transfersOf('task-root');
    expect(transfer.status).toBe('expired');
    expect((await filesOf(transfer.id)).map((f) => f.status)).toEqual(['expired', 'expired']);
    expect(fs.existsSync(path.join(TRANSFERS_BASE_DIR, transfer.id))).toBe(false);
  });

  obligation('rule-failure.UnroutedTransferExpired.1', async () => {
    // The task delivered text only: there is no transfer of its own, and
    // another task's pending transfer is not touched.
    await world({ mainStatus: 'closed' });
    await createTask(taskRow({ id: 'task-other', status: 'completed', result: 'x', closed_at: now() }));
    await endedInvocation('inv-other', 'sess-main');
    await getDb().run(
      `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
       VALUES ('xfer-other', 'task-other', 'inv-other', 'x', 0, 1, ?, 'pending', NULL)`,
      now(),
    );
    await getDb().run(
      `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
       VALUES ('tf-other', 'xfer-other', 'x.md', '/nowhere/x.md', 'owned', NULL)`,
    );
    await rootTask();

    await deliver('sess-root', { result_text: 'text only' });

    expect((await getTask('task-root'))!.status).toBe('completed');
    expect(await transfersOf('task-root')).toEqual([]);
    expect((await transfersOf('task-other'))[0].status).toBe('pending');
    expect((await filesOf('xfer-other'))[0].status).toBe('owned');
  });

  obligation('rule-failure.UnroutedTransferExpired.2', async () => {
    // The task's transfer is no longer pending (already placed, in transit).
    await world({ mainStatus: 'closed' });
    const task = await rootTask({ status: 'completed', result: 'r', closed_at: now() });
    await endedInvocation('inv-root', 'sess-root');
    await getDb().run(
      `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
       VALUES ('xfer-root', 'task-root', 'inv-root', 'r', 0, 1, ?, 'in_transit', NULL)`,
      now(),
    );
    await getDb().run(
      `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
       VALUES ('tf-root', 'xfer-root', 'r.md', '/nowhere/r.md', 'placed', NULL)`,
    );

    await routeResult(task);

    expect((await transfersOf('task-root'))[0].status).toBe('in_transit');
    expect((await filesOf('xfer-root'))[0].status).toBe('placed');
  });

  obligation('rule-failure.UnroutedTransferExpired.3', async () => {
    // The result has a recipient (an active main session): its transfer
    // stays pending for the recipient's next invocation.
    await world();
    await rootTask();
    await startInvocation('sess-root', { 'report.md': 'r' });

    await deliver('sess-root', { result_text: 'see report.md', file_paths: ['report.md'] });

    const [transfer] = await transfersOf('task-root');
    expect(transfer.status).toBe('pending');
    expect(transfer.recipient_session_id).toBe('sess-main');
    expect((await filesOf(transfer.id)).map((f) => f.status)).toEqual(['owned']);
    expect(fs.existsSync(hostStagingPath(transfer.id, 'report.md'))).toBe(true);
  });
});
