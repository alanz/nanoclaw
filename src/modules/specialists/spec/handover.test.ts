/**
 * Propagated from specs/specialists.allium: file handover and invocations —
 * InvocationStarted, OrphanInvocationEnded, TransferFilesPlaced,
 * TransferMovedToInTransit, TransferPlacedIntoLiveIpcIn, InvocationEnded,
 * InvocationEndedOnTaskTerminal, the transfer expiry/reset rules, and the
 * IpcOutMount / IpcInMount / ContainerTransfer / TransferFile status graphs.
 *
 * Every transition is driven through the real code (buildInvocationForSession,
 * endInvocationById, routeResult, expireTransfersForTerminalTask) against a
 * real test DB and real temp directories. Only the container runtime and the
 * session mailbox are stubbed. Status changes are observed through SQLite
 * triggers installed at setup that log every status write into an audit
 * table, so a transient state (committed) and a no-op rewrite are both
 * visible, and a transition graph can be checked against every write the code
 * actually made.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-spec-handover';

const mailbox = vi.hoisted(() => ({
  acked: [] as string[],
  pending: [] as string[],
  processing: [] as string[],
}));

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-spec-handover/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-spec-handover/groups',
  };
});
vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));
vi.mock('../../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session-manager.js')>()),
  writeSessionMessage: vi.fn(),
  withExistingMailboxSession: vi.fn(async (_ag: string, _s: string, action: (m: unknown) => unknown) =>
    action({
      getTerminalProcessingAcks: () => mailbox.acked.map((messageId) => ({ messageId, status: 'completed' })),
      getMessageForRetry: (id: string, status: 'pending' | 'processing') =>
        (status === 'pending' ? mailbox.pending : mailbox.processing).includes(id) ? { id } : undefined,
      failPendingMessages: () => undefined,
    }),
  ),
}));

import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createSession } from '../../../db/sessions.js';
import type { Session } from '../../../types.js';
import { SPECIALISTS_CONFIG } from '../config.js';
import { createSpecialist, createTask, getTask } from '../db.js';
import {
  buildInvocationForSession,
  endActiveInvocationForSession,
  endInvocationById,
  expireTransfersForTerminalTask,
  invocationIpcInPath,
  invocationIpcOutPath,
  IPC_BASE_DIR,
  placeTransferIntoActiveIpcIn,
  TRANSFERS_BASE_DIR,
} from '../invocation.js';
import { routeResult } from '../routing.js';
import type { ContainerTransfer, SpecialistTask } from '../types.js';
import { covered, divergence, obligation } from './harness.js';

const now = () => new Date().toISOString();

// ── Declared transition graphs (specs/specialists.allium) ────────────────────

const MOUNT_EDGES = new Set(['active>cleared']);
const TRANSFER_EDGES = new Set([
  'pending>in_transit',
  'pending>committed',
  'pending>expired',
  'in_transit>pending',
  'in_transit>expired',
  'committed>expired',
]);
const FILE_EDGES = new Set(['owned>placed', 'owned>expired', 'placed>owned', 'placed>expired']);

// ── Fixture ─────────────────────────────────────────────────────────────────

type Tbl = 'container_transfers' | 'transfer_files' | 'ipc_out_mounts' | 'ipc_in_mounts';

async function installAudit(): Promise<void> {
  const db = getDb();
  await db.exec(
    'CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_id TEXT NOT NULL, old TEXT, new TEXT)',
  );
  for (const tbl of ['container_transfers', 'transfer_files', 'ipc_out_mounts', 'ipc_in_mounts'] as Tbl[]) {
    await db.exec(
      `CREATE TRIGGER audit_${tbl} AFTER UPDATE OF status ON ${tbl}
         BEGIN INSERT INTO audit (tbl, row_id, old, new) VALUES ('${tbl}', NEW.id, OLD.status, NEW.status); END`,
    );
  }
}

/** Every status write the code made, in order (including no-op rewrites). */
async function writes(tbl: Tbl, rowId?: string): Promise<Array<{ seq: number; old: string; new: string }>> {
  const rows = (await getDb().all(
    `SELECT seq, old, new FROM audit WHERE tbl = ? ${rowId ? 'AND row_id = ?' : ''} ORDER BY seq`,
    ...(rowId ? [tbl, rowId] : [tbl]),
  )) as Array<{ seq: number; old: string; new: string }>;
  return rows;
}

/** The status changes (old != new) as "old>new" edges. */
async function edges(tbl: Tbl, rowId?: string): Promise<string[]> {
  return (await writes(tbl, rowId)).filter((w) => w.old !== w.new).map((w) => `${w.old}>${w.new}`);
}

async function lastSeq(): Promise<number> {
  const row = (await getDb().get('SELECT COALESCE(MAX(seq), 0) AS s FROM audit')) as { s: number };
  return row.s;
}

async function writesSince(seq: number, tbl: Tbl, rowIds: string[]): Promise<number> {
  const rows = (await getDb().all('SELECT row_id FROM audit WHERE seq > ? AND tbl = ?', seq, tbl)) as Array<{
    row_id: string;
  }>;
  return rows.filter((r) => rowIds.includes(r.row_id)).length;
}

async function statusOf(tbl: Tbl, id: string): Promise<string> {
  return ((await getDb().get(`SELECT status FROM ${tbl} WHERE id = ?`, id)) as { status: string }).status;
}

async function mountsOf(invocationId: string): Promise<{
  out: { id: string; status: string }[];
  in: { id: string; status: string }[];
}> {
  const db = getDb();
  return {
    out: (await db.all('SELECT id, status FROM ipc_out_mounts WHERE invocation_id = ?', invocationId)) as {
      id: string;
      status: string;
    }[],
    in: (await db.all('SELECT id, status FROM ipc_in_mounts WHERE invocation_id = ?', invocationId)) as {
      id: string;
      status: string;
    }[],
  };
}

async function endedAt(invocationId: string): Promise<string | null> {
  return (
    (await getDb().get('SELECT ended_at FROM invocations WHERE id = ?', invocationId)) as { ended_at: string | null }
  ).ended_at;
}

const sessionBase = {
  agent_provider: null,
  status: 'active' as const,
  container_status: 'stopped' as const,
  processing_state: 'idle' as const,
};

async function session(id: string, agentGroup: string, thread: string | null): Promise<Session> {
  const s = {
    ...sessionBase,
    id,
    agent_group_id: agentGroup,
    messaging_group_id: null,
    thread_id: thread,
    last_active: now(),
    created_at: now(),
  };
  await createSession(s);
  return s as unknown as Session;
}

async function getSessionRow(id: string): Promise<Session> {
  return (await getDb().get('SELECT * FROM sessions WHERE id = ?', id)) as Session;
}

function taskRow(id: string, status: SpecialistTask['status'], requesterTask: string | null): SpecialistTask {
  return {
    id,
    specialist_group_id: 'ag-spec',
    prompt: 'p',
    requester_group_id: requesterTask ? null : 'ag-main',
    requester_task_id: requesterTask,
    requester_session_id: 'sess-main',
    depth: requesterTask ? 1 : 0,
    chain_delegation_count: 0,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status,
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: status === 'completed' ? 'done' : null,
    failure_kind: status === 'failed' ? 'timeout' : null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };
}

/** A specialist task and (unless `noSession`) its per-task session `sess-<id>`. */
async function task(
  id: string,
  status: SpecialistTask['status'],
  requesterTask: string | null,
  opts: { noSession?: boolean; requesterSession?: string } = {},
): Promise<SpecialistTask> {
  const t = { ...taskRow(id, status, requesterTask), requester_session_id: opts.requesterSession ?? 'sess-main' };
  await createTask(t);
  if (!opts.noSession) await session(`sess-${id}`, 'ag-spec', id);
  return t;
}

/** Main group, a specialist group, the main session, and an ended sender invocation. */
async function world(): Promise<void> {
  for (const id of ['ag-main', 'ag-spec']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  await createSpecialist({
    agent_group_id: 'ag-spec',
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
  await session('sess-main', 'ag-main', null);
  await session('sess-sender', 'ag-spec', null);
  await getDb().run(
    `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at, ended_at)
     VALUES ('inv-sender', 'sess-sender', NULL, '/x/out', '/x/in', ?, ?)`,
    now(),
    now(),
  );
}

interface XferOpts {
  id: string;
  task: string;
  status?: ContainerTransfer['status'];
  recipient?: string | null;
  routed?: string | null;
  commit?: boolean;
  files?: Array<{ id: string; name: string; status?: 'owned' | 'placed' | 'expired' }>;
}

/** A transfer with staged files whose host copies really exist. */
async function transfer(o: XferOpts): Promise<ContainerTransfer> {
  const db = getDb();
  const files = o.files ?? [{ id: `${o.id}-f1`, name: 'report.md' }];
  await db.run(
    `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id, routed_message_id)
     VALUES (?, ?, 'inv-sender', 'see the report', ?, ?, ?, ?, ?, ?)`,
    o.id,
    o.task,
    o.commit ? 1 : 0,
    files.length,
    now(),
    o.status ?? 'pending',
    o.recipient ?? null,
    o.routed ?? null,
  );
  fs.mkdirSync(path.join(TRANSFERS_BASE_DIR, o.id), { recursive: true });
  for (const f of files) {
    const hostPath = path.join(TRANSFERS_BASE_DIR, o.id, f.name);
    fs.writeFileSync(hostPath, `contents of ${f.name}`);
    await db.run(
      `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path) VALUES (?, ?, ?, ?, ?, NULL)`,
      f.id,
      o.id,
      f.name,
      hostPath,
      f.status ?? 'owned',
    );
  }
  return (await db.get('SELECT * FROM container_transfers WHERE id = ?', o.id)) as ContainerTransfer;
}

async function getTransfer(id: string): Promise<ContainerTransfer> {
  return (await getDb().get('SELECT * FROM container_transfers WHERE id = ?', id)) as ContainerTransfer;
}

async function start(sessionId: string): Promise<string> {
  const built = await buildInvocationForSession(await getSessionRow(sessionId));
  return built!.invocationId;
}

async function setTaskStatus(id: string, status: SpecialistTask['status']): Promise<SpecialistTask> {
  await getDb().run('UPDATE specialist_tasks SET status = ? WHERE id = ?', status, id);
  return (await getTask(id))!;
}

const staged = (transferId: string) => fs.existsSync(path.join(TRANSFERS_BASE_DIR, transferId));
const inIpcIn = (invocationId: string, transferId: string, name: string) =>
  path.join(invocationIpcInPath(invocationId), transferId, name);

/**
 * An open invocation (ended_at NULL) whose mount rows are in the given state —
 * `null` for no row at all. Built with raw SQL: the code always inserts both
 * mounts as active with the invocation, and only endInvocationById ever clears
 * them (both together, with ended_at). Such a state is reachable only through
 * a host crash between the inserts (missing rows), never with mixed statuses.
 */
async function invocationWithMounts(
  id: string,
  sessionId: string,
  out: 'active' | 'cleared' | null,
  in_: 'active' | 'cleared' | null,
): Promise<void> {
  const db = getDb();
  fs.mkdirSync(invocationIpcOutPath(id), { recursive: true });
  fs.mkdirSync(invocationIpcInPath(id), { recursive: true });
  await db.run(
    `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at, ended_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL)`,
    id,
    sessionId,
    invocationIpcOutPath(id),
    invocationIpcInPath(id),
    now(),
  );
  if (out)
    await db.run('INSERT INTO ipc_out_mounts (id, invocation_id, status) VALUES (?, ?, ?)', `${id}-out`, id, out);
  if (in_) await db.run('INSERT INTO ipc_in_mounts (id, invocation_id, status) VALUES (?, ?, ?)', `${id}-in`, id, in_);
}

const MOUNT_GUARD_REASON =
  'the code keys "active invocation" on invocations.ended_at, not on mount status: getActiveInvocation (invocation.ts:205) ' +
  'and endInvocationById (invocation.ts:299-307) check only ended_at and clear both mounts unconditionally; the mixed or ' +
  'missing-mount state is reachable only via a host crash between the mount inserts (invocation.ts:142-158)';

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  mailbox.acked = [];
  mailbox.pending = [];
  mailbox.processing = [];
  await runMigrations(await initTestDb());
  await installAudit();
  await world();
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── IpcOutMount / IpcInMount status graphs ───────────────────────────────────

describe('IpcOutMount.status', () => {
  obligation('transition-edge.IpcOutMount.active.cleared', async () => {
    const inv = await start('sess-main');
    const [out] = (await mountsOf(inv)).out;
    expect(out.status).toBe('active');

    await endInvocationById(inv); // InvocationEnded

    expect(await edges('ipc_out_mounts', out.id)).toEqual(['active>cleared']);
    expect(await statusOf('ipc_out_mounts', out.id)).toBe('cleared');
  });

  obligation('transition-rejected.IpcOutMount.status', async () => {
    // Every path that touches mounts, in sequence: start, orphan recovery,
    // container exit, task-terminal end, late duplicate ends.
    await task('t1', 'running', null);
    const a = await start('sess-main');
    const b = await start('sess-main'); // orphan-ends a
    await endInvocationById(b);
    await endInvocationById(a); // late close event
    const c = await start('sess-t1');
    await routeResult(await setTaskStatus('t1', 'completed'));
    await endActiveInvocationForSession('sess-t1');
    await endInvocationById(c);

    const seen = await edges('ipc_out_mounts');
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) expect(MOUNT_EDGES, `undeclared IpcOutMount transition ${e}`).toContain(e);
  });

  obligation('transition-terminal.IpcOutMount.status', async () => {
    const inv = await start('sess-main');
    const [out] = (await mountsOf(inv)).out;
    await endInvocationById(inv);
    const after = await lastSeq();

    // A late close event, a new invocation for the session (orphan check),
    // and its end: none may write to the cleared mount.
    await endInvocationById(inv);
    await endActiveInvocationForSession('sess-main');
    const next = await start('sess-main');
    await endInvocationById(next);

    expect(await writesSince(after, 'ipc_out_mounts', [out.id])).toBe(0);
    expect(await statusOf('ipc_out_mounts', out.id)).toBe('cleared');
  });
});

describe('IpcInMount.status', () => {
  obligation('transition-edge.IpcInMount.active.cleared', async () => {
    // Witnessed by InvocationEndedOnTaskTerminal: the task ends, the host
    // clears the live invocation's mounts without waiting for the exit.
    await task('t1', 'running', null);
    const inv = await start('sess-t1');
    const [inMount] = (await mountsOf(inv)).in;
    expect(inMount.status).toBe('active');

    await routeResult(await setTaskStatus('t1', 'completed'));

    expect(await edges('ipc_in_mounts', inMount.id)).toEqual(['active>cleared']);
  });

  obligation('transition-rejected.IpcInMount.status', async () => {
    await task('t1', 'running', null);
    const a = await start('sess-t1');
    const b = await start('sess-t1');
    await endInvocationById(a);
    await routeResult(await setTaskStatus('t1', 'failed'));
    await endInvocationById(b);
    const m = await start('sess-main');
    await endActiveInvocationForSession('sess-main');
    await endInvocationById(m);

    const seen = await edges('ipc_in_mounts');
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) expect(MOUNT_EDGES, `undeclared IpcInMount transition ${e}`).toContain(e);
  });

  obligation('transition-terminal.IpcInMount.status', async () => {
    await task('t1', 'running', null);
    const inv = await start('sess-t1');
    const [inMount] = (await mountsOf(inv)).in;
    await routeResult(await setTaskStatus('t1', 'completed'));
    const after = await lastSeq();

    await endInvocationById(inv); // the container's own close event, afterwards
    await endActiveInvocationForSession('sess-t1');

    expect(await writesSince(after, 'ipc_in_mounts', [inMount.id])).toBe(0);
    expect(await statusOf('ipc_in_mounts', inMount.id)).toBe('cleared');
  });
});

// ── ContainerTransfer status graph ──────────────────────────────────────────

describe('ContainerTransfer.status', () => {
  obligation('transition-edge.ContainerTransfer.pending.in_transit', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });

    const inv = await start('sess-p'); // TransferMovedToInTransit

    expect(await edges('container_transfers', 'x')).toEqual(['pending>in_transit']);
    expect(fs.readFileSync(inIpcIn(inv, 'x', 'report.md'), 'utf-8')).toBe('contents of report.md');
  });

  obligation('transition-edge.ContainerTransfer.pending.committed', async () => {
    const t = await task('r', 'completed', null, { noSession: true });
    const x = await transfer({ id: 'x', task: 'r', commit: true });

    await routeResult(t, x); // SpecialistResultRoutedToMain, commit path

    expect((await edges('container_transfers', 'x'))[0]).toBe('pending>committed');
    expect(fs.existsSync(path.join(ROOT, 'groups', 'ag-main', 'zettel/reports', 'report.md'))).toBe(true);
  });

  obligation('transition-edge.ContainerTransfer.pending.expired', async () => {
    // TransferExpiredOnRequesterFailed on a transfer never placed: the parent
    // ended before its next invocation could pick the child's result up.
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });

    await routeResult(await setTaskStatus('p', 'failed'));

    expect(await edges('container_transfers', 'x')).toEqual(['pending>expired']);
    expect(staged('x')).toBe(false);
  });

  obligation('transition-edge.ContainerTransfer.in_transit.pending', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });
    const inv = await start('sess-p');
    await setTaskStatus('p', 'awaiting_restart'); // crashed, will be restarted

    await endInvocationById(inv); // TransferResetOnRecipientCrash

    expect(await edges('container_transfers', 'x')).toEqual(['pending>in_transit', 'in_transit>pending']);
    expect(staged('x')).toBe(true);
  });

  obligation('transition-edge.ContainerTransfer.in_transit.expired', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });
    await start('sess-p');

    await routeResult(await setTaskStatus('p', 'completed')); // TransferExpiredOnRequesterTerminal

    expect(await edges('container_transfers', 'x')).toEqual(['pending>in_transit', 'in_transit>expired']);
    expect(staged('x')).toBe(false);
  });

  obligation('transition-edge.ContainerTransfer.committed.expired', async () => {
    const t = await task('r', 'completed', null, { noSession: true });
    const x = await transfer({ id: 'x', task: 'r', commit: true });

    await routeResult(t, x);

    expect(await edges('container_transfers', 'x')).toEqual(['pending>committed', 'committed>expired']);
    expect(staged('x')).toBe(false);
    // The memory copy persists after the staging copy is reclaimed.
    expect(fs.existsSync(path.join(ROOT, 'groups', 'ag-main', 'zettel/reports', 'report.md'))).toBe(true);
  });

  obligation('transition-rejected.ContainerTransfer.status', async () => {
    // A battery over every handover path; every status change the code makes
    // must be a declared edge.
    // 1. Sub-task: placed, parent crashes (reset), restarts (re-placed), completes.
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x-sub', task: 'c', recipient: 'sess-p' });
    const p1 = await start('sess-p');
    await setTaskStatus('p', 'awaiting_restart');
    await endInvocationById(p1);
    await setTaskStatus('p', 'running');
    await start('sess-p');
    await routeResult(await setTaskStatus('p', 'completed'));
    // 2. Root, live placement into a running main container that exits before
    //    the message, then is restarted and handles it.
    const r = await task('r', 'completed', null, { noSession: true });
    const m1 = await start('sess-main');
    await routeResult(r, await transfer({ id: 'x-root', task: 'r' }));
    const routed = (await getTransfer('x-root')).routed_message_id!;
    mailbox.pending = [routed];
    await endInvocationById(m1);
    const m2 = await start('sess-main');
    mailbox.pending = [];
    mailbox.acked = [routed];
    await endInvocationById(m2);
    // 3. Root commit to memory.
    const k = await task('k', 'completed', null, { noSession: true });
    await routeResult(k, await transfer({ id: 'x-commit', task: 'k', commit: true }));
    // 4. Delivering task fails before routing.
    const f = await task('f', 'failed', null, { noSession: true });
    await transfer({ id: 'x-failed', task: 'f' });
    await routeResult(f);

    const seen = await edges('container_transfers');
    expect(new Set(seen)).toEqual(new Set([...TRANSFER_EDGES]));
    for (const e of seen) expect(TRANSFER_EDGES, `undeclared ContainerTransfer transition ${e}`).toContain(e);
    for (const id of ['x-sub', 'x-root', 'x-commit', 'x-failed']) {
      expect(await statusOf('container_transfers', id)).toBe('expired');
    }
  });

  obligation('transition-terminal.ContainerTransfer.status', async () => {
    // An expired transfer is not revived by its recipient starting again, by a
    // mid-invocation placement attempt with a stale (pending) copy of the row,
    // by an exit, or by another terminal sweep.
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    const stale = await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });
    await expireTransfersForTerminalTask('p');
    expect(await statusOf('container_transfers', 'x')).toBe('expired');
    const after = await lastSeq();

    const inv = await start('sess-p');
    await placeTransferIntoActiveIpcIn('sess-p', stale);
    await setTaskStatus('p', 'awaiting_restart');
    await endInvocationById(inv);
    await expireTransfersForTerminalTask('p');

    const later = (await writes('container_transfers', 'x')).filter((w) => w.seq > after);
    expect(later.every((w) => w.new === 'expired')).toBe(true);
    expect(await statusOf('container_transfers', 'x')).toBe('expired');
    expect(fs.existsSync(path.join(invocationIpcInPath(inv), 'x'))).toBe(false);
  });
});

// ── TransferFile status graph ────────────────────────────────────────────────

describe('TransferFile.status', () => {
  obligation('transition-edge.TransferFile.owned.placed', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });

    const inv = await start('sess-p'); // TransferFilesPlaced

    expect(await edges('transfer_files', 'x-f1')).toEqual(['owned>placed']);
    expect(fs.existsSync(inIpcIn(inv, 'x', 'report.md'))).toBe(true);
  });

  obligation('transition-edge.TransferFile.owned.expired', async () => {
    // Never placed: committed to memory.
    const t = await task('r', 'completed', null, { noSession: true });
    const x = await transfer({ id: 'x', task: 'r', commit: true });

    await routeResult(t, x);

    expect(await edges('transfer_files', 'x-f1')).toEqual(['owned>expired']);
    const f = (await getDb().get("SELECT memory_path FROM transfer_files WHERE id = 'x-f1'")) as {
      memory_path: string;
    };
    expect(f.memory_path).toBe(`${SPECIALISTS_CONFIG.memoryReportsSubpath}/report.md`);
  });

  obligation('transition-edge.TransferFile.placed.owned', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });
    const inv = await start('sess-p');
    await setTaskStatus('p', 'awaiting_restart');

    await endInvocationById(inv);

    expect(await edges('transfer_files', 'x-f1')).toEqual(['owned>placed', 'placed>owned']);
  });

  obligation('transition-edge.TransferFile.placed.expired', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });
    await start('sess-p');

    await routeResult(await setTaskStatus('p', 'completed'));

    expect(await edges('transfer_files', 'x-f1')).toEqual(['owned>placed', 'placed>expired']);
  });

  obligation('transition-rejected.TransferFile.status', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({
      id: 'x-sub',
      task: 'c',
      recipient: 'sess-p',
      files: [
        { id: 'a', name: 'a.md' },
        { id: 'b', name: 'b.md' },
      ],
    });
    const p1 = await start('sess-p');
    await setTaskStatus('p', 'awaiting_restart');
    await endInvocationById(p1);
    await setTaskStatus('p', 'running');
    await start('sess-p');
    await routeResult(await setTaskStatus('p', 'failed'));
    const r = await task('r', 'completed', null, { noSession: true });
    const m1 = await start('sess-main');
    await routeResult(r, await transfer({ id: 'x-root', task: 'r', files: [{ id: 'rf', name: 'r.md' }] }));
    mailbox.acked = [(await getTransfer('x-root')).routed_message_id!];
    await endInvocationById(m1);
    const k = await task('k', 'completed', null, { noSession: true });
    await routeResult(
      k,
      await transfer({ id: 'x-commit', task: 'k', commit: true, files: [{ id: 'kf', name: 'k.md' }] }),
    );

    const seen = await edges('transfer_files');
    expect(new Set(seen)).toEqual(new Set([...FILE_EDGES]));
    for (const e of seen) expect(FILE_EDGES, `undeclared TransferFile transition ${e}`).toContain(e);
  });

  obligation('transition-terminal.TransferFile.status', async () => {
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    const stale = await transfer({ id: 'x', task: 'c', recipient: 'sess-p' });
    await expireTransfersForTerminalTask('p');
    const after = await lastSeq();

    const inv = await start('sess-p');
    await placeTransferIntoActiveIpcIn('sess-p', stale);
    await setTaskStatus('p', 'awaiting_restart');
    await endInvocationById(inv);

    const later = (await writes('transfer_files', 'x-f1')).filter((w) => w.seq > after);
    expect(later.every((w) => w.new === 'expired')).toBe(true);
    expect(await statusOf('transfer_files', 'x-f1')).toBe('expired');
  });
});

// ── InvocationStarted / OrphanInvocationEnded ────────────────────────────────

describe('InvocationStarted', () => {
  obligation('rule-success.InvocationStarted', async () => {
    const r = await task('r', 'completed', null, { noSession: true });
    await transfer({ id: 'x', task: r.id, recipient: 'sess-main', routed: 'msg-1' });

    const built = (await buildInvocationForSession(await getSessionRow('sess-main')))!;

    const m = await mountsOf(built.invocationId);
    expect(m.out.map((x) => x.status)).toEqual(['active']);
    expect(m.in.map((x) => x.status)).toEqual(['active']);
    // IpcInPopulated: the file is in ipc-in, under the transfer's own
    // subdirectory, before the container is handed its mounts.
    expect(fs.readFileSync(inIpcIn(built.invocationId, 'x', 'report.md'), 'utf-8')).toBe('contents of report.md');
    expect(fs.readdirSync(invocationIpcOutPath(built.invocationId))).toEqual([]);
  });

  obligation('rule-entity-creation.InvocationStarted.1', async () => {
    await task('t1', 'running', null);

    const built = (await buildInvocationForSession(await getSessionRow('sess-t1')))!;

    const inv = (await getDb().get('SELECT * FROM invocations WHERE id = ?', built.invocationId)) as {
      session_id: string;
      task_id: string | null;
      ended_at: string | null;
    };
    expect(inv).toMatchObject({ session_id: 'sess-t1', task_id: 't1', ended_at: null });
    const m = await mountsOf(built.invocationId);
    expect(m.out).toHaveLength(1);
    expect(m.in).toHaveLength(1);
    expect(m.out[0].status).toBe('active');
    expect(m.in[0].status).toBe('active');
    expect(built.mounts).toEqual([
      {
        hostPath: invocationIpcOutPath(built.invocationId),
        containerPath: SPECIALISTS_CONFIG.ipcOutContainerPath,
        readonly: false,
      },
      {
        hostPath: invocationIpcInPath(built.invocationId),
        containerPath: SPECIALISTS_CONFIG.ipcInContainerPath,
        readonly: true,
      },
    ]);
    expect(fs.statSync(invocationIpcOutPath(built.invocationId)).isDirectory()).toBe(true);
    expect(fs.statSync(invocationIpcInPath(built.invocationId)).isDirectory()).toBe(true);
  });
});

describe('OrphanInvocationEnded', () => {
  obligation('rule-success.OrphanInvocationEnded', async () => {
    const orphan = await start('sess-main'); // its close event never arrives

    const next = await start('sess-main');

    const o = await mountsOf(orphan);
    expect([o.out[0].status, o.in[0].status]).toEqual(['cleared', 'cleared']);
    expect(await endedAt(orphan)).not.toBeNull();
    const n = await mountsOf(next);
    expect([n.out[0].status, n.in[0].status]).toEqual(['active', 'active']);
  });

  obligation('rule-failure.OrphanInvocationEnded.1', async () => {
    // No orphan for this session: its earlier invocation ended normally. An
    // active invocation of a different session is not this session's orphan.
    const earlier = await start('sess-main');
    await endInvocationById(earlier);
    const endedBefore = await endedAt(earlier);
    await task('t1', 'running', null);
    const other = await start('sess-t1');
    const after = await lastSeq();

    await start('sess-main');

    const ids = [...(await mountsOf(earlier)).out, ...(await mountsOf(other)).out].map((m) => m.id);
    expect(await writesSince(after, 'ipc_out_mounts', ids)).toBe(0);
    const o = await mountsOf(other);
    expect([o.out[0].status, o.in[0].status]).toEqual(['active', 'active']);
    expect(await endedAt(earlier)).toBe(endedBefore);
  });

  obligation('rule-failure.OrphanInvocationEnded.2', async () => {
    // The orphan check never selects the invocation being created.
    await start('sess-main');

    const next = await start('sess-main');

    const n = await mountsOf(next);
    expect([n.out[0].status, n.in[0].status]).toEqual(['active', 'active']);
    expect(await endedAt(next)).toBeNull();
  });

  divergence('rule-failure.OrphanInvocationEnded.3', MOUNT_GUARD_REASON, async () => {
    // Orphan with no ipc-out mount row (its ipc-in active).
    await invocationWithMounts('inv-o', 'sess-main', null, 'active');

    await start('sess-main');

    expect(await statusOf('ipc_in_mounts', 'inv-o-in')).toBe('active');
  });

  divergence('rule-failure.OrphanInvocationEnded.4', MOUNT_GUARD_REASON, async () => {
    await invocationWithMounts('inv-o', 'sess-main', 'active', null);

    await start('sess-main');

    expect(await statusOf('ipc_out_mounts', 'inv-o-out')).toBe('active');
  });

  divergence('rule-failure.OrphanInvocationEnded.5', MOUNT_GUARD_REASON, async () => {
    await invocationWithMounts('inv-o', 'sess-main', 'cleared', 'active');

    await start('sess-main');

    expect(await statusOf('ipc_in_mounts', 'inv-o-in')).toBe('active');
  });

  divergence('rule-failure.OrphanInvocationEnded.6', MOUNT_GUARD_REASON, async () => {
    await invocationWithMounts('inv-o', 'sess-main', 'active', 'cleared');

    await start('sess-main');

    expect(await statusOf('ipc_out_mounts', 'inv-o-out')).toBe('active');
  });
});

// ── TransferFilesPlaced / TransferMovedToInTransit ───────────────────────────

describe('placement at invocation start', () => {
  async function twoTransfersToParent(): Promise<void> {
    await task('p', 'running', null);
    await task('q', 'running', null);
    await task('c1', 'completed', 'p', { noSession: true });
    await task('c2', 'completed', 'p', { noSession: true });
    await task('c3', 'completed', 'q', { noSession: true });
    // Two children's results for p, both named report.md; one for q.
    await transfer({ id: 'x1', task: 'c1', recipient: 'sess-p' });
    await transfer({
      id: 'x2',
      task: 'c2',
      recipient: 'sess-p',
      files: [
        { id: 'x2-f1', name: 'report.md' },
        { id: 'x2-f2', name: 'data.csv' },
      ],
    });
    await transfer({ id: 'x3', task: 'c3', recipient: 'sess-q' });
  }

  obligation('rule-success.TransferFilesPlaced', async () => {
    await twoTransfersToParent();

    const inv = await start('sess-p');

    for (const id of ['x1-f1', 'x2-f1', 'x2-f2']) expect(await statusOf('transfer_files', id)).toBe('placed');
    expect(await statusOf('transfer_files', 'x3-f1')).toBe('owned'); // targets another session
    // Per-transfer subdirectories keep same-named files apart.
    expect(fs.existsSync(inIpcIn(inv, 'x1', 'report.md'))).toBe(true);
    expect(fs.existsSync(inIpcIn(inv, 'x2', 'report.md'))).toBe(true);
    expect(fs.existsSync(inIpcIn(inv, 'x2', 'data.csv'))).toBe(true);
    expect(fs.existsSync(path.join(invocationIpcInPath(inv), 'x3'))).toBe(false);
  });

  obligation('rule-success.TransferMovedToInTransit', async () => {
    await twoTransfersToParent();

    await start('sess-p');

    expect(await statusOf('container_transfers', 'x1')).toBe('in_transit');
    expect(await statusOf('container_transfers', 'x2')).toBe('in_transit');
    expect(await statusOf('container_transfers', 'x3')).toBe('pending');
  });
});

// ── TransferPlacedIntoLiveIpcIn ──────────────────────────────────────────────

describe('TransferPlacedIntoLiveIpcIn', () => {
  /** A root task whose result arrives while the main container is running. */
  async function liveMain(): Promise<{ inv: string; t: SpecialistTask }> {
    const inv = await start('sess-main');
    const t = await task('r', 'completed', null, { noSession: true });
    return { inv, t };
  }

  obligation('rule-success.TransferPlacedIntoLiveIpcIn', async () => {
    const { inv, t } = await liveMain();
    const x = await transfer({ id: 'x', task: 'r' });

    await routeResult(t, x);

    expect(await statusOf('container_transfers', 'x')).toBe('in_transit');
    expect(await statusOf('transfer_files', 'x-f1')).toBe('placed');
    expect(fs.readFileSync(inIpcIn(inv, 'x', 'report.md'), 'utf-8')).toBe('contents of report.md');
  });

  obligation('rule-failure.TransferPlacedIntoLiveIpcIn.1', async () => {
    // No transfer for this task (a text-only result). Another task's transfer
    // already staged for the main session is not placed on its behalf.
    const { inv, t } = await liveMain();
    await task('other', 'completed', null, { noSession: true });
    await transfer({ id: 'x-other', task: 'other', recipient: 'sess-main', routed: 'msg-other' });

    await routeResult(t, null);

    expect(fs.readdirSync(invocationIpcInPath(inv))).toEqual([]);
    expect(await statusOf('container_transfers', 'x-other')).toBe('pending');
    expect(await statusOf('transfer_files', 'x-other-f1')).toBe('owned');
  });

  obligation('rule-failure.TransferPlacedIntoLiveIpcIn.2', async () => {
    // The transfer is no longer pending (already expired).
    const { inv, t } = await liveMain();
    const x = await transfer({
      id: 'x',
      task: 'r',
      status: 'expired',
      files: [{ id: 'f', name: 'r.md', status: 'expired' }],
    });

    await routeResult(t, x);

    expect(await statusOf('container_transfers', 'x')).toBe('expired');
    expect(await statusOf('transfer_files', 'f')).toBe('expired');
    expect(fs.readdirSync(invocationIpcInPath(inv))).toEqual([]);
  });

  obligation('rule-failure.TransferPlacedIntoLiveIpcIn.3', async () => {
    // commit_to_memory: the files go to memory, never into ipc-in.
    const { inv, t } = await liveMain();
    const x = await transfer({ id: 'x', task: 'r', commit: true });

    await routeResult(t, x);

    expect(fs.readdirSync(invocationIpcInPath(inv))).toEqual([]);
    expect(await statusOf('transfer_files', 'x-f1')).not.toBe('placed');
    expect(await edges('container_transfers', 'x')).not.toContain('pending>in_transit');
  });

  obligation('rule-failure.TransferPlacedIntoLiveIpcIn.4', async () => {
    // The requesting main session no longer exists.
    const inv = await start('sess-main');
    await session('sess-gone', 'ag-main', 'gone');
    const t = await task('r', 'completed', null, { noSession: true, requesterSession: 'sess-gone' });
    const x = await transfer({ id: 'x', task: 'r' });
    await getDb().exec('PRAGMA foreign_keys = OFF');
    await getDb().run("DELETE FROM sessions WHERE id = 'sess-gone'");
    await getDb().exec('PRAGMA foreign_keys = ON');

    await routeResult(t, x);

    expect(await edges('container_transfers', 'x')).not.toContain('pending>in_transit');
    expect(await edges('transfer_files', 'x-f1')).not.toContain('owned>placed');
    expect(fs.readdirSync(invocationIpcInPath(inv))).toEqual([]);
  });

  obligation('rule-failure.TransferPlacedIntoLiveIpcIn.5', async () => {
    // No live invocation: staged for the next start instead.
    const t = await task('r', 'completed', null, { noSession: true });
    const x = await transfer({ id: 'x', task: 'r' });

    await routeResult(t, x);

    expect(await statusOf('container_transfers', 'x')).toBe('pending');
    expect(await statusOf('transfer_files', 'x-f1')).toBe('owned');
    expect((await getTransfer('x')).recipient_session_id).toBe('sess-main');
    expect(staged('x')).toBe(true);
  });
});

// ── InvocationEnded ──────────────────────────────────────────────────────────

describe('InvocationEnded', () => {
  obligation('rule-success.InvocationEnded', async () => {
    const inv = await start('sess-main');
    fs.writeFileSync(path.join(invocationIpcOutPath(inv), 'unsent.md'), 'never delivered');

    await endInvocationById(inv);

    const m = await mountsOf(inv);
    expect([m.out[0].status, m.in[0].status]).toEqual(['cleared', 'cleared']);
    // Files left in ipc-out that no delivery consumed are discarded.
    expect(fs.existsSync(path.join(IPC_BASE_DIR, inv))).toBe(false);
  });

  divergence('rule-failure.InvocationEnded.1', MOUNT_GUARD_REASON, async () => {
    await invocationWithMounts('inv-o', 'sess-main', null, 'active');

    await endInvocationById('inv-o');

    expect(await statusOf('ipc_in_mounts', 'inv-o-in')).toBe('active');
  });

  divergence('rule-failure.InvocationEnded.2', MOUNT_GUARD_REASON, async () => {
    await invocationWithMounts('inv-o', 'sess-main', 'active', null);

    await endInvocationById('inv-o');

    expect(await statusOf('ipc_out_mounts', 'inv-o-out')).toBe('active');
  });

  divergence('rule-failure.InvocationEnded.3', MOUNT_GUARD_REASON, async () => {
    await invocationWithMounts('inv-o', 'sess-main', 'cleared', 'active');

    await endInvocationById('inv-o');

    expect(await statusOf('ipc_in_mounts', 'inv-o-in')).toBe('active');
  });

  divergence('rule-failure.InvocationEnded.4', MOUNT_GUARD_REASON, async () => {
    await invocationWithMounts('inv-o', 'sess-main', 'active', 'cleared');

    await endInvocationById('inv-o');

    expect(await statusOf('ipc_out_mounts', 'inv-o-out')).toBe('active');
  });
});

// ── InvocationEndedOnTaskTerminal ────────────────────────────────────────────

describe('InvocationEndedOnTaskTerminal', () => {
  obligation('rule-success.InvocationEndedOnTaskTerminal', async () => {
    await task('t1', 'running', null);
    await task('t2', 'running', null);
    const i1 = await start('sess-t1');
    const i2 = await start('sess-t2');

    await routeResult(await setTaskStatus('t1', 'completed'));
    await routeResult(await setTaskStatus('t2', 'failed'));

    for (const inv of [i1, i2]) {
      const m = await mountsOf(inv);
      expect([m.out[0].status, m.in[0].status]).toEqual(['cleared', 'cleared']);
    }
  });

  obligation('rule-failure.InvocationEndedOnTaskTerminal.1', async () => {
    // A task created already failed (sub-task rejection) never had a session.
    // Nothing else's invocation is ended on its behalf.
    await task('p', 'running', null);
    const pInv = await start('sess-p');
    const mainInv = await start('sess-main');
    const rejected = await task('rej', 'failed', 'p', { noSession: true });
    const after = await lastSeq();

    await routeResult(rejected);

    const ids = [...(await mountsOf(pInv)).out, ...(await mountsOf(mainInv)).out].map((m) => m.id);
    expect(await writesSince(after, 'ipc_out_mounts', ids)).toBe(0);
    expect(await endedAt(pInv)).toBeNull();
    expect(await endedAt(mainInv)).toBeNull();
  });

  obligation('rule-failure.InvocationEndedOnTaskTerminal.2', async () => {
    // Session provisioned, but no live invocation (its container already
    // exited, or never started).
    await task('t1', 'running', null);
    const earlier = await start('sess-t1');
    await endInvocationById(earlier);
    const endedBefore = await endedAt(earlier);
    const after = await lastSeq();

    await routeResult(await setTaskStatus('t1', 'failed'));

    expect(
      await writesSince(
        after,
        'ipc_out_mounts',
        (await mountsOf(earlier)).out.map((m) => m.id),
      ),
    ).toBe(0);
    expect(
      await writesSince(
        after,
        'ipc_in_mounts',
        (await mountsOf(earlier)).in.map((m) => m.id),
      ),
    ).toBe(0);
    expect(await endedAt(earlier)).toBe(endedBefore);
  });

  divergence('rule-failure.InvocationEndedOnTaskTerminal.3', MOUNT_GUARD_REASON, async () => {
    await task('t1', 'running', null);
    await invocationWithMounts('inv-o', 'sess-t1', null, 'active');

    await routeResult(await setTaskStatus('t1', 'completed'));

    expect(await statusOf('ipc_in_mounts', 'inv-o-in')).toBe('active');
  });

  divergence('rule-failure.InvocationEndedOnTaskTerminal.4', MOUNT_GUARD_REASON, async () => {
    await task('t1', 'running', null);
    await invocationWithMounts('inv-o', 'sess-t1', 'active', null);

    await routeResult(await setTaskStatus('t1', 'completed'));

    expect(await statusOf('ipc_out_mounts', 'inv-o-out')).toBe('active');
  });

  divergence('rule-failure.InvocationEndedOnTaskTerminal.5', MOUNT_GUARD_REASON, async () => {
    await task('t1', 'running', null);
    await invocationWithMounts('inv-o', 'sess-t1', 'cleared', 'active');

    await routeResult(await setTaskStatus('t1', 'completed'));

    expect(await statusOf('ipc_in_mounts', 'inv-o-in')).toBe('active');
  });

  divergence('rule-failure.InvocationEndedOnTaskTerminal.6', MOUNT_GUARD_REASON, async () => {
    await task('t1', 'running', null);
    await invocationWithMounts('inv-o', 'sess-t1', 'active', 'cleared');

    await routeResult(await setTaskStatus('t1', 'completed'));

    expect(await statusOf('ipc_out_mounts', 'inv-o-out')).toBe('active');
  });
});

// ── Transfer expiry and reset ────────────────────────────────────────────────

describe('expiry on the requester task ending', () => {
  /**
   * Parent p with two children's transfers: x-in already placed into p's
   * running invocation (in_transit), x-wait staged after it started (pending).
   * Plus a root-task transfer to the main session, which p's ending must not
   * touch.
   */
  async function parentHolding(): Promise<void> {
    await task('p', 'running', null);
    await task('c1', 'completed', 'p', { noSession: true });
    await task('c2', 'completed', 'p', { noSession: true });
    await task('r', 'completed', null, { noSession: true });
    await transfer({ id: 'x-in', task: 'c1', recipient: 'sess-p' });
    await start('sess-p');
    await transfer({ id: 'x-wait', task: 'c2', recipient: 'sess-p' });
    await transfer({ id: 'x-root', task: 'r', recipient: 'sess-main', routed: 'msg-r' });
    expect(await statusOf('container_transfers', 'x-in')).toBe('in_transit');
  }

  async function expectExpired(): Promise<void> {
    for (const id of ['x-in', 'x-wait']) {
      expect(await statusOf('container_transfers', id)).toBe('expired');
      expect(await statusOf('transfer_files', `${id}-f1`)).toBe('expired');
      expect(staged(id)).toBe(false);
    }
    expect(await statusOf('container_transfers', 'x-root')).toBe('pending');
    expect(staged('x-root')).toBe(true);
  }

  obligation('rule-success.TransferExpiredOnRequesterTerminal', async () => {
    await parentHolding();

    await routeResult(await setTaskStatus('p', 'completed'));

    await expectExpired();
  });

  obligation('rule-success.TransferExpiredOnRequesterFailed', async () => {
    await parentHolding();

    await routeResult(await setTaskStatus('p', 'failed'));

    await expectExpired();
  });
});

covered(
  'rule-success.TransferExpiredOnRoutedMessageCompleted',
  'src/modules/specialists/main-transfer-expiry.test.ts',
  'expires them once the message carrying them was handled',
);
covered(
  'rule-success.TransferExpiredOnRoutedMessageFailed',
  'src/modules/specialists/main-transfer-expiry.test.ts',
  'expires them when the message failed and will never be read',
);
covered(
  'rule-success.TransferResetOnRecipientCrash',
  'src/modules/specialists/invocation-identity.test.ts',
  "keeps a live task's in-transit files for its next container",
);
covered(
  'rule-failure.TransferResetOnRecipientCrash.2',
  'src/modules/specialists/invocation-identity.test.ts',
  "expires a finished task's in-transit files",
);
covered(
  'rule-success.TransferResetOnMainRecipientExit',
  'src/modules/specialists/main-transfer-expiry.test.ts',
  'keeps them for the next container when it exited before reaching the message',
);

describe('reset on recipient exit', () => {
  obligation('rule-failure.TransferResetOnRecipientCrash.1', async () => {
    // The recipient invocation has no task (main agent). Its exit does not
    // take the crash-reset path: with the routed message handled, the files
    // placed live are done with rather than rolled back to pending.
    const inv = await start('sess-main');
    const t = await task('r', 'completed', null, { noSession: true });
    await routeResult(t, await transfer({ id: 'x', task: 'r' }));
    mailbox.acked = [(await getTransfer('x')).routed_message_id!];

    await endInvocationById(inv);

    expect(await edges('container_transfers', 'x')).toEqual(['pending>in_transit', 'in_transit>expired']);
    expect(await edges('transfer_files', 'x-f1')).toEqual(['owned>placed', 'placed>expired']);
  });

  obligation('rule-failure.TransferResetOnMainRecipientExit.1', async () => {
    // The recipient invocation has a task (finished), so the routed-message
    // check does not apply: even with a message still unhandled in the
    // mailbox, the transfer is not reset.
    await task('p', 'running', null);
    await task('c', 'completed', 'p', { noSession: true });
    await transfer({ id: 'x', task: 'c', recipient: 'sess-p', routed: 'msg-owed' });
    const inv = await start('sess-p');
    await setTaskStatus('p', 'completed');
    mailbox.pending = ['msg-owed'];

    await endInvocationById(inv);

    expect(await statusOf('container_transfers', 'x')).toBe('expired');
    expect(await edges('container_transfers', 'x')).not.toContain('in_transit>pending');
  });

  obligation('rule-success.PendingTransferExpiredOnDeliveringTaskFailed', async () => {
    // The task failed after its host took ownership of the files but before
    // the result was routed anywhere.
    const f = await task('f', 'failed', null);
    await transfer({ id: 'x', task: 'f' });

    await routeResult(f);

    expect(await edges('container_transfers', 'x')).toEqual(['pending>expired']);
    expect(await statusOf('transfer_files', 'x-f1')).toBe('expired');
    expect(staged('x')).toBe(false);
  });
});
