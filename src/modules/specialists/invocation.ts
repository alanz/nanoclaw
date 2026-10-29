import path from 'path';
import fs from 'fs';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import type { ContainerTransfer, Invocation, TransferFile } from './types.js';
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import { SPECIALISTS_CONFIG } from './config.js';

export const IPC_BASE_DIR = path.join(DATA_DIR, 'v2-ipc');
export const TRANSFERS_BASE_DIR = path.join(DATA_DIR, 'v2-transfers');

export function invocationIpcOutPath(invocationId: string): string {
  return path.join(IPC_BASE_DIR, invocationId, 'out');
}

export function invocationIpcInPath(invocationId: string): string {
  return path.join(IPC_BASE_DIR, invocationId, 'in');
}

export function hostStagingPath(transferId: string, filename: string): string {
  return path.join(TRANSFERS_BASE_DIR, transferId, filename);
}

/**
 * Delete a transfer's host staging copies. Only once the transfer is
 * expired: until then (pending, in_transit) a later invocation may need them
 * to place the files again. Before this nothing reclaimed them except the
 * all-files-failed delivery path, so data/v2-transfers grew with every
 * delivery that carried files (P12).
 */
export function reclaimTransferStaging(transferId: string): void {
  try {
    fs.rmSync(path.join(TRANSFERS_BASE_DIR, transferId), { recursive: true, force: true });
  } catch (err) {
    log.warn('specialists: could not reclaim transfer staging', { transferId, err });
  }
}

/**
 * Reclaim the staging of every transfer that can no longer be placed: expired
 * (or the transient committed), or unknown to the DB. Run at host start, when
 * no delivery is in flight — it clears what piled up before reclamation
 * existed and anything a crash left behind.
 */
/**
 * Remove the ipc directory of every invocation that has ended, or that the DB
 * does not know. Run at host start: those still active (a container adopted
 * across the restart) keep theirs.
 */
export async function sweepInvocationDirs(): Promise<number> {
  if (!fs.existsSync(IPC_BASE_DIR)) return 0;
  const db = getDb();
  if (!(await db.hasTable('invocations'))) return 0;
  let removed = 0;
  for (const invocationId of fs.readdirSync(IPC_BASE_DIR)) {
    const row = (await db.get('SELECT ended_at FROM invocations WHERE id = ?', invocationId)) as
      | { ended_at: string | null }
      | undefined;
    if (row && row.ended_at === null) continue;
    try {
      fs.rmSync(path.join(IPC_BASE_DIR, invocationId), { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn('specialists: could not remove invocation directory', { invocationId, err });
    }
  }
  return removed;
}

export async function sweepTransferStaging(): Promise<number> {
  if (!fs.existsSync(TRANSFERS_BASE_DIR)) return 0;
  const db = getDb();
  if (!(await db.hasTable('container_transfers'))) return 0;
  let reclaimed = 0;
  for (const transferId of fs.readdirSync(TRANSFERS_BASE_DIR)) {
    const row = (await db.get('SELECT status FROM container_transfers WHERE id = ?', transferId)) as
      | { status: string }
      | undefined;
    if (row && (row.status === 'pending' || row.status === 'in_transit')) continue;
    reclaimTransferStaging(transferId);
    reclaimed++;
  }
  return reclaimed;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build ipc mounts for a new container invocation.
 * Returns mounts to append and the invocation ID, or null if the invocations
 * table isn't present (file-handover migration not yet applied).
 */
export async function buildInvocationForSession(
  session: Session,
): Promise<{ mounts: VolumeMount[]; invocationId: string } | null> {
  const db = getDb();
  if (!(await db.hasTable('invocations'))) return null;

  // Resolve task_id for specialist sessions: a specialist task's session is
  // the one whose thread_id is that task, in the task's own agent group (the
  // same identity getLiveTasksWithSessions joins on). Not "no messaging
  // group": specialist sessions carry the null-channel messaging group, so
  // that test never matched and task_id was never recorded.
  let taskId: string | null = null;
  if (session.thread_id) {
    const row = (await db.get(
      'SELECT id FROM specialist_tasks WHERE id = ? AND specialist_group_id = ?',
      session.thread_id,
      session.agent_group_id,
    )) as { id: string } | undefined;
    if (row) taskId = row.id;
  }

  // End any orphaned active invocation for this session. This can happen when
  // the container close event doesn't fire (e.g. Apple Container), leaving the
  // previous invocation's ended_at NULL. Ending it now keeps getActiveInvocation
  // unambiguous and prevents placeTransferIntoActiveIpcIn from routing files to
  // a stale ipc-in directory on the next result delivery.
  //
  // Any handover call the orphan left unhandled is handled first, so the
  // files it named are owned before its ipc-out goes (spec:
  // handover_calls_handled on OrphanInvocationEnded).
  const orphan = await getActiveInvocation(session.id);
  if (orphan) {
    try {
      const { deliverSessionMessages } = await import('../../delivery.js');
      await deliverSessionMessages(session, { waitForInflight: true });
    } catch (err) {
      log.warn('specialists: draining before ending an orphaned invocation failed', { invocationId: orphan.id, err });
    }
    await endInvocationById(orphan.id);
  }

  const invocationId = genId('inv');
  const ipcOutPath = invocationIpcOutPath(invocationId);
  const ipcInPath = invocationIpcInPath(invocationId);
  const now = new Date().toISOString();

  fs.mkdirSync(ipcOutPath, { recursive: true });
  fs.mkdirSync(ipcInPath, { recursive: true });

  // Populate ipc-in from pending transfers targeting this session
  await _populateIpcIn(db, session.id, ipcInPath);

  // One step: an invocation with only one of its mounts (a host stopped
  // between the inserts) is a state nothing else in the module expects.
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      invocationId,
      session.id,
      taskId,
      ipcOutPath,
      ipcInPath,
      now,
    );
    await db.run(
      'INSERT INTO ipc_out_mounts (id, invocation_id, status) VALUES (?, ?, ?)',
      genId('ipcout'),
      invocationId,
      'active',
    );
    await db.run(
      'INSERT INTO ipc_in_mounts (id, invocation_id, status) VALUES (?, ?, ?)',
      genId('ipcin'),
      invocationId,
      'active',
    );
  });

  log.debug('specialists: invocation started', { invocationId, sessionId: session.id, taskId });

  return {
    mounts: [
      { hostPath: ipcOutPath, containerPath: SPECIALISTS_CONFIG.ipcOutContainerPath, readonly: false },
      { hostPath: ipcInPath, containerPath: SPECIALISTS_CONFIG.ipcInContainerPath, readonly: true },
    ],
    invocationId,
  };
}

async function _populateIpcIn(db: ReturnType<typeof getDb>, sessionId: string, ipcInHostPath: string): Promise<void> {
  const transfers = (await db.all(
    "SELECT * FROM container_transfers WHERE status = 'pending' AND commit_to_memory = 0 AND recipient_session_id = ?",
    sessionId,
  )) as ContainerTransfer[];

  for (const transfer of transfers) {
    const files = (await db.all(
      "SELECT * FROM transfer_files WHERE transfer_id = ? AND status = 'owned'",
      transfer.id,
    )) as TransferFile[];

    if (files.length === 0) continue;

    const subdir = path.join(ipcInHostPath, transfer.id);
    fs.mkdirSync(subdir, { recursive: true });

    for (const file of files) {
      try {
        fs.copyFileSync(file.host_path, path.join(subdir, file.original_name));
        await db.run("UPDATE transfer_files SET status = 'placed', reached_recipient = 1 WHERE id = ?", file.id);
      } catch (err) {
        log.warn('specialists: failed to copy transfer file to ipc-in', {
          transferId: transfer.id,
          file: file.original_name,
          err,
        });
      }
    }

    await db.run("UPDATE container_transfers SET status = 'in_transit' WHERE id = ?", transfer.id);
    log.debug('specialists: transfer placed in ipc-in', { transferId: transfer.id, sessionId });
  }
}

/** Get the active (not-yet-ended) invocation for a session. */
export async function getActiveInvocation(sessionId: string): Promise<Invocation | undefined> {
  const db = getDb();
  if (!(await db.hasTable('invocations'))) return undefined;
  return (await db.get(
    'SELECT * FROM invocations WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    sessionId,
  )) as Invocation | undefined;
}

/**
 * Copy a staged transfer into the active invocation's ipc-in directory.
 * Called by routing.ts immediately after setting recipient_session_id so that
 * files are available even when the requester container is already running
 * (i.e. the spawn-time _populateIpcIn ran before the transfer was created).
 */
export async function placeTransferIntoActiveIpcIn(sessionId: string, transfer: ContainerTransfer): Promise<void> {
  const db = getDb();
  const invocation = await getActiveInvocation(sessionId);
  if (!invocation) return;

  if (transfer.commit_to_memory === 1) return;

  const files = (await db.all(
    "SELECT * FROM transfer_files WHERE transfer_id = ? AND status = 'owned'",
    transfer.id,
  )) as TransferFile[];

  if (files.length === 0) return;

  const subdir = path.join(invocation.ipc_in_host_path, transfer.id);
  fs.mkdirSync(subdir, { recursive: true });

  for (const file of files) {
    try {
      fs.copyFileSync(file.host_path, path.join(subdir, file.original_name));
      await db.run("UPDATE transfer_files SET status = 'placed', reached_recipient = 1 WHERE id = ?", file.id);
    } catch (err) {
      log.warn('specialists: failed to copy transfer file to active ipc-in', {
        transferId: transfer.id,
        file: file.original_name,
        err,
      });
    }
  }

  await db.run("UPDATE container_transfers SET status = 'in_transit' WHERE id = ?", transfer.id);
  log.debug('specialists: transfer placed into active ipc-in', {
    transferId: transfer.id,
    sessionId,
    invocationId: invocation.id,
  });
}

/**
 * End the active invocation for a session, if any.
 * Called by routing.ts when the specialist task reaches a terminal state so
 * cleanup happens synchronously on the host rather than relying on the
 * container close event (which may not fire reliably on all runtimes).
 */
export async function endActiveInvocationForSession(sessionId: string): Promise<void> {
  const invocation = await getActiveInvocation(sessionId);
  if (invocation) {
    await endInvocationById(invocation.id);
  }
}

/**
 * End an invocation: clear mount records, expire in-transit transfers whose
 * files were in this ipc-in, and clean up ipc directories.
 */
export async function endInvocationById(invocationId: string): Promise<void> {
  const db = getDb();
  if (!(await db.hasTable('invocations'))) return;

  const inv = (await db.get('SELECT * FROM invocations WHERE id = ?', invocationId)) as Invocation | undefined;
  if (!inv || inv.ended_at) return;

  const now = new Date().toISOString();
  await db.run('UPDATE invocations SET ended_at = ? WHERE id = ?', now, invocationId);
  await db.run("UPDATE ipc_out_mounts SET status = 'cleared' WHERE invocation_id = ?", invocationId);
  await db.run("UPDATE ipc_in_mounts SET status = 'cleared' WHERE invocation_id = ?", invocationId);

  // Handle in_transit transfers whose files were in this ipc-in (now being deleted).
  //
  // Whether to expire or reset depends on whether the recipient session's task is
  // still alive:
  //   - Main-agent sessions have no associated specialist task — the agent consumed
  //     the files this turn, so expire.
  //   - Specialist sessions whose task is terminal — expire (task is done).
  //   - Specialist sessions whose task is NOT terminal (crash / awaiting_restart) —
  //     reset to pending + files back to owned so the next invocation's
  //     _populateIpcIn can re-place them from host staging. Expiring here would
  //     lose the files across retries, violating the "files survive task restarts"
  //     invariant.
  // A specialist task's session: thread_id = task, same agent group (see
  // buildInvocationForSession). A messaging-group test here never matched, so
  // in-transit files were expired on every restart instead of kept.
  const taskRow = (await db.get(
    `SELECT st.status
       FROM sessions s
       JOIN specialist_tasks st ON st.id = s.thread_id AND st.specialist_group_id = s.agent_group_id
       WHERE s.id = ?`,
    inv.session_id,
  )) as { status: string } | undefined;

  const taskAlive = taskRow != null && taskRow.status !== 'completed' && taskRow.status !== 'failed';

  const inTransit = (await db.all(
    "SELECT id, kind, routed_message_id FROM container_transfers WHERE status = 'in_transit' AND recipient_session_id = ?",
    inv.session_id,
  )) as { id: string; kind: string; routed_message_id: string | null }[];

  // A main-agent session (no task) expires a transfer once the message that
  // carried it has been handled; one the container exited before reaching is
  // still owed to the turn that will read it, so it is kept like a live task's
  // (spec: TransferExpiredOnRoutedMessage*, TransferResetOnMainRecipientExit).
  const { owed, failed } =
    taskRow == null
      ? await routedMessageOutcomes(inv.session_id, inTransit)
      : { owed: new Set<string>(), failed: new Set<string>() };
  const { parkTransfer } = await import('./handover.js');

  // A main session's transfer still pending when its message was handled never
  // reached the agent and never will: done with, like a placed one.
  if (taskRow == null) {
    const waiting = (await db.all(
      "SELECT id, routed_message_id FROM container_transfers WHERE status = 'pending' AND recipient_session_id = ? AND routed_message_id IS NOT NULL",
      inv.session_id,
    )) as { id: string; routed_message_id: string | null }[];
    const stillOwed = (await routedMessageOutcomes(inv.session_id, waiting)).owed;
    for (const t of waiting.filter((w) => !stillOwed.has(w.id))) {
      await parkTransfer(t.id, 'its message was handled before the files reached the agent');
    }
  }

  for (const t of inTransit) {
    // Files handed to this task at dispatch are settled with the task, not
    // its run: used up if it completed, given back if it failed
    // (expireTransfersForTerminalTask, returnDispatchedFiles). A run ended at
    // the terminal transition comes first, so expiring them here would lose
    // a failed task's files before they could go back.
    if (taskAlive || owed.has(t.id) || t.kind === 'dispatch') {
      await db.run("UPDATE transfer_files SET status = 'owned' WHERE transfer_id = ? AND status = 'placed'", t.id);
      await db.run("UPDATE container_transfers SET status = 'pending' WHERE id = ?", t.id);
    } else if (failed.has(t.id)) {
      // The message carrying them will never be handled: unread (spec:
      // TransferOrphanedOnRoutedMessageFailed).
      await parkTransfer(t.id, 'the message carrying it failed');
    } else {
      await db.run("UPDATE transfer_files SET status = 'expired' WHERE transfer_id = ?", t.id);
      await db.run("UPDATE container_transfers SET status = 'expired' WHERE id = ?", t.id);
      reclaimTransferStaging(t.id);
    }
  }

  // Clean up ipc directories — and the per-invocation directory holding them,
  // which removing only out/ and in/ left behind (459 empty ones here).
  try {
    fs.rmSync(inv.ipc_out_host_path, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(inv.ipc_in_host_path, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(path.join(IPC_BASE_DIR, invocationId), { recursive: true, force: true });
  } catch {}

  log.debug('specialists: invocation ended', { invocationId, sessionId: inv.session_id });
}

/**
 * For transfers to a main-agent session, what became of each one's routed
 * message: still owed to the agent (pending or processing on the host's side,
 * and not acked done by the container, whose ack the host may not have
 * synced), or failed (acked failed — it will never be handled). Anything else
 * was handled. A transfer with no routed message (written before it was
 * recorded), or a session with no mailbox, counts as handled.
 */
async function routedMessageOutcomes(
  sessionId: string,
  transfers: { id: string; routed_message_id: string | null }[],
): Promise<{ owed: Set<string>; failed: Set<string> }> {
  const routed = transfers.filter((t) => t.routed_message_id != null);
  const none = { owed: new Set<string>(), failed: new Set<string>() };
  if (routed.length === 0) return none;
  const session = (await getDb().get('SELECT agent_group_id FROM sessions WHERE id = ?', sessionId)) as
    | { agent_group_id: string }
    | undefined;
  if (!session) return none;
  const outcome = await withExistingMailboxSession(session.agent_group_id, sessionId, (mailbox) => {
    const acks = new Map(mailbox.getTerminalProcessingAcks().map((a) => [a.messageId, a.status as string]));
    const owed: string[] = [];
    const failed: string[] = [];
    for (const t of routed) {
      const id = t.routed_message_id!;
      const ack = acks.get(id);
      if (ack === 'failed') failed.push(t.id);
      else if (ack !== undefined) continue;
      else if (mailbox.getMessageForRetry(id, 'pending') ?? mailbox.getMessageForRetry(id, 'processing'))
        owed.push(t.id);
    }
    return { owed: new Set(owed), failed: new Set(failed) };
  });
  return outcome ?? none;
}

/**
 * Settle the transfers tied to a task that has reached a terminal state.
 * Files that reached their reader expire; files that never will are parked
 * (spec: TransferParked) — never dropped unseen (NamedFilesNeverLost).
 *
 * - Results its sub-tasks delivered to it: read ones expire, unread ones are
 *   parked (TransferExpiredOnRequesterTerminal / ...Failed).
 * - Its own result transfer still unrouted: parked
 *   (UnroutedTransferOrphaned, PendingTransferOrphanedOnDeliveringTaskFailed).
 * - Files handed to it at dispatch: used up when it completed; a failure has
 *   already given them back (routing.ts), and anything left is parked.
 * - Files given back to its session: read ones expire, the rest are parked
 *   (ReturnedTransferEndsWithRecipientTask).
 */
export async function expireTransfersForTerminalTask(taskId: string): Promise<void> {
  const db = getDb();
  if (!(await db.hasTable('container_transfers'))) return;
  const { parkTransfer } = await import('./handover.js');

  const retire = async (id: string): Promise<void> => {
    await db.run("UPDATE transfer_files SET status = 'expired' WHERE transfer_id = ?", id);
    await db.run("UPDATE container_transfers SET status = 'expired' WHERE id = ?", id);
    reclaimTransferStaging(id);
  };

  const fromChildren = (await db.all(
    `SELECT ct.id, ct.status FROM container_transfers ct
       JOIN specialist_tasks st ON st.id = ct.task_id
       WHERE ct.status IN ('pending', 'in_transit', 'committed')
         AND ct.kind = 'result'
         AND st.requester_task_id = ?`,
    taskId,
  )) as { id: string; status: string }[];
  for (const t of fromChildren) {
    if (t.status === 'pending') await parkTransfer(t.id, 'its requester task ended before receiving it');
    else await retire(t.id);
  }

  // Its own result, never routed to anyone. Transfers with
  // recipient_session_id set have been routed and are settled by their
  // recipient (the routed message, or the parent task's end).
  const unrouted = (await db.all(
    "SELECT id FROM container_transfers WHERE task_id = ? AND kind = 'result' AND status = 'pending' AND recipient_session_id IS NULL",
    taskId,
  )) as { id: string }[];
  for (const { id } of unrouted) await parkTransfer(id, 'its result could not be routed');

  const task = (await db.get('SELECT status, specialist_group_id FROM specialist_tasks WHERE id = ?', taskId)) as
    | { status: string; specialist_group_id: string }
    | undefined;

  const dispatched = (await db.all(
    "SELECT id FROM container_transfers WHERE task_id = ? AND kind = 'dispatch' AND status IN ('pending', 'in_transit')",
    taskId,
  )) as { id: string }[];
  for (const { id } of dispatched) {
    if (task?.status === 'completed') await retire(id);
    else await parkTransfer(id, 'its task ended without using it');
  }

  const session = task
    ? ((await db.get(
        'SELECT id FROM sessions WHERE agent_group_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 1',
        task.specialist_group_id,
        taskId,
      )) as { id: string } | undefined)
    : undefined;
  if (session) {
    const returned = (await db.all(
      "SELECT id, status FROM container_transfers WHERE kind = 'returned' AND recipient_session_id = ? AND status IN ('pending', 'in_transit')",
      session.id,
    )) as { id: string; status: string }[];
    for (const t of returned) {
      if (t.status === 'pending') await parkTransfer(t.id, 'returned to a task that ended before receiving it');
      else await retire(t.id);
    }
  }
}
