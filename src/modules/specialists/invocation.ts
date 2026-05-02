import path from 'path';
import fs from 'fs';

import { DATA_DIR } from '../../config.js';
import { getDb, hasTable } from '../../db/connection.js';
import { log } from '../../log.js';
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

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build ipc mounts for a new container invocation.
 * Returns mounts to append and the invocation ID, or null if the invocations
 * table isn't present (file-handover migration not yet applied).
 */
export function buildInvocationForSession(session: Session): { mounts: VolumeMount[]; invocationId: string } | null {
  const db = getDb();
  if (!hasTable(db, 'invocations')) return null;

  // Resolve task_id for specialist sessions
  let taskId: string | null = null;
  if (!session.messaging_group_id && session.thread_id) {
    const row = db.prepare('SELECT id FROM specialist_tasks WHERE id = ?').get(session.thread_id) as
      | { id: string }
      | undefined;
    if (row) taskId = row.id;
  }

  // End any orphaned active invocation for this session. This can happen when
  // the container close event doesn't fire (e.g. Apple Container), leaving the
  // previous invocation's ended_at NULL. Ending it now keeps getActiveInvocation
  // unambiguous and prevents placeTransferIntoActiveIpcIn from routing files to
  // a stale ipc-in directory on the next result delivery.
  const orphan = getActiveInvocation(session.id);
  if (orphan) {
    endInvocationById(orphan.id);
  }

  const invocationId = genId('inv');
  const ipcOutPath = invocationIpcOutPath(invocationId);
  const ipcInPath = invocationIpcInPath(invocationId);
  const now = new Date().toISOString();

  fs.mkdirSync(ipcOutPath, { recursive: true });
  fs.mkdirSync(ipcInPath, { recursive: true });

  // Populate ipc-in from pending transfers targeting this session
  _populateIpcIn(db, session.id, ipcInPath);

  db.prepare(
    `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(invocationId, session.id, taskId, ipcOutPath, ipcInPath, now);

  db.prepare('INSERT INTO ipc_out_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run(
    genId('ipcout'),
    invocationId,
    'active',
  );
  db.prepare('INSERT INTO ipc_in_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run(
    genId('ipcin'),
    invocationId,
    'active',
  );

  log.debug('specialists: invocation started', { invocationId, sessionId: session.id, taskId });

  return {
    mounts: [
      { hostPath: ipcOutPath, containerPath: SPECIALISTS_CONFIG.ipcOutContainerPath, readonly: false },
      { hostPath: ipcInPath, containerPath: SPECIALISTS_CONFIG.ipcInContainerPath, readonly: true },
    ],
    invocationId,
  };
}

function _populateIpcIn(db: ReturnType<typeof getDb>, sessionId: string, ipcInHostPath: string): void {
  const transfers = db
    .prepare(
      "SELECT * FROM container_transfers WHERE status = 'pending' AND commit_to_memory = 0 AND recipient_session_id = ?",
    )
    .all(sessionId) as ContainerTransfer[];

  for (const transfer of transfers) {
    const files = db
      .prepare("SELECT * FROM transfer_files WHERE transfer_id = ? AND status = 'owned'")
      .all(transfer.id) as TransferFile[];

    if (files.length === 0) continue;

    const subdir = path.join(ipcInHostPath, transfer.id);
    fs.mkdirSync(subdir, { recursive: true });

    for (const file of files) {
      try {
        fs.copyFileSync(file.host_path, path.join(subdir, file.original_name));
        db.prepare("UPDATE transfer_files SET status = 'placed' WHERE id = ?").run(file.id);
      } catch (err) {
        log.warn('specialists: failed to copy transfer file to ipc-in', {
          transferId: transfer.id,
          file: file.original_name,
          err,
        });
      }
    }

    db.prepare("UPDATE container_transfers SET status = 'in_transit' WHERE id = ?").run(transfer.id);
    log.debug('specialists: transfer placed in ipc-in', { transferId: transfer.id, sessionId });
  }
}

/** Get the active (not-yet-ended) invocation for a session. */
export function getActiveInvocation(sessionId: string): Invocation | undefined {
  const db = getDb();
  if (!hasTable(db, 'invocations')) return undefined;
  return db
    .prepare('SELECT * FROM invocations WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .get(sessionId) as Invocation | undefined;
}

/**
 * Copy a staged transfer into the active invocation's ipc-in directory.
 * Called by routing.ts immediately after setting recipient_session_id so that
 * files are available even when the requester container is already running
 * (i.e. the spawn-time _populateIpcIn ran before the transfer was created).
 */
export function placeTransferIntoActiveIpcIn(sessionId: string, transfer: ContainerTransfer): void {
  const db = getDb();
  const invocation = getActiveInvocation(sessionId);
  if (!invocation) return;

  if (transfer.commit_to_memory === 1) return;

  const files = db
    .prepare("SELECT * FROM transfer_files WHERE transfer_id = ? AND status = 'owned'")
    .all(transfer.id) as TransferFile[];

  if (files.length === 0) return;

  const subdir = path.join(invocation.ipc_in_host_path, transfer.id);
  fs.mkdirSync(subdir, { recursive: true });

  for (const file of files) {
    try {
      fs.copyFileSync(file.host_path, path.join(subdir, file.original_name));
      db.prepare("UPDATE transfer_files SET status = 'placed' WHERE id = ?").run(file.id);
    } catch (err) {
      log.warn('specialists: failed to copy transfer file to active ipc-in', {
        transferId: transfer.id,
        file: file.original_name,
        err,
      });
    }
  }

  db.prepare("UPDATE container_transfers SET status = 'in_transit' WHERE id = ?").run(transfer.id);
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
export function endActiveInvocationForSession(sessionId: string): void {
  const invocation = getActiveInvocation(sessionId);
  if (invocation) {
    endInvocationById(invocation.id);
  }
}

/**
 * End an invocation: clear mount records, expire in-transit transfers whose
 * files were in this ipc-in, and clean up ipc directories.
 */
export function endInvocationById(invocationId: string): void {
  const db = getDb();
  if (!hasTable(db, 'invocations')) return;

  const inv = db.prepare('SELECT * FROM invocations WHERE id = ?').get(invocationId) as Invocation | undefined;
  if (!inv || inv.ended_at) return;

  const now = new Date().toISOString();
  db.prepare('UPDATE invocations SET ended_at = ? WHERE id = ?').run(now, invocationId);
  db.prepare("UPDATE ipc_out_mounts SET status = 'cleared' WHERE invocation_id = ?").run(invocationId);
  db.prepare("UPDATE ipc_in_mounts SET status = 'cleared' WHERE invocation_id = ?").run(invocationId);

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
  const taskRow = db
    .prepare(
      `SELECT st.status
       FROM sessions s
       JOIN specialist_tasks st ON st.id = s.thread_id
       WHERE s.id = ? AND s.messaging_group_id IS NULL`,
    )
    .get(inv.session_id) as { status: string } | undefined;

  const taskAlive = taskRow != null && taskRow.status !== 'completed' && taskRow.status !== 'failed';

  if (taskAlive) {
    db.prepare(
      `UPDATE transfer_files SET status = 'owned'
       WHERE transfer_id IN (
         SELECT id FROM container_transfers
         WHERE status = 'in_transit' AND recipient_session_id = ?
       )`,
    ).run(inv.session_id);
    db.prepare(
      "UPDATE container_transfers SET status = 'pending' WHERE status = 'in_transit' AND recipient_session_id = ?",
    ).run(inv.session_id);
  } else {
    db.prepare(
      `UPDATE transfer_files SET status = 'expired'
       WHERE transfer_id IN (
         SELECT id FROM container_transfers
         WHERE status = 'in_transit' AND recipient_session_id = ?
       )`,
    ).run(inv.session_id);
    db.prepare(
      "UPDATE container_transfers SET status = 'expired' WHERE status = 'in_transit' AND recipient_session_id = ?",
    ).run(inv.session_id);
  }

  // Clean up ipc directories
  try {
    fs.rmSync(inv.ipc_out_host_path, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(inv.ipc_in_host_path, { recursive: true, force: true });
  } catch {}

  log.debug('specialists: invocation ended', { invocationId, sessionId: inv.session_id });
}

/**
 * Expire pending and in-transit/committed transfers for a task that has
 * reached a terminal state. Called by the routing module.
 *
 * For sub-task transfers: a transfer's requester is the parent task
 * (t.task.requester_task). We expire transfers from child tasks that
 * targeted this task when this task transitions to terminal.
 */
export function expireTransfersForTerminalTask(taskId: string): void {
  const db = getDb();
  if (!hasTable(db, 'container_transfers')) return;

  // Expire transfers WHERE the delivering task's requester_task_id = taskId
  // (i.e. the delivery was for a sub-task of this task that became terminal)
  const transfersToExpire = db
    .prepare(
      `SELECT ct.id FROM container_transfers ct
       JOIN specialist_tasks st ON st.id = ct.task_id
       WHERE ct.status IN ('in_transit', 'committed')
         AND st.requester_task_id = ?`,
    )
    .all(taskId) as { id: string }[];

  for (const { id } of transfersToExpire) {
    db.prepare("UPDATE transfer_files SET status = 'expired' WHERE transfer_id = ?").run(id);
    db.prepare("UPDATE container_transfers SET status = 'expired' WHERE id = ?").run(id);
  }

  // Also expire pending transfers for the task itself that haven't been staged for delivery yet.
  // Transfers with recipient_session_id already set have been routed to an ipc-in dir and must
  // not be expired here — the delivery sweep will advance them to in_transit/committed.
  const pendingTransfers = db
    .prepare(
      "SELECT id FROM container_transfers WHERE task_id = ? AND status = 'pending' AND recipient_session_id IS NULL",
    )
    .all(taskId) as { id: string }[];

  for (const { id } of pendingTransfers) {
    db.prepare("UPDATE transfer_files SET status = 'expired' WHERE transfer_id = ?").run(id);
    db.prepare("UPDATE container_transfers SET status = 'expired' WHERE id = ?").run(id);
  }
}
