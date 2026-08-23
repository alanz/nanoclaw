import path from 'path';
import fs from 'fs';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
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
export async function buildInvocationForSession(
  session: Session,
): Promise<{ mounts: VolumeMount[]; invocationId: string } | null> {
  const db = getDb();
  if (!(await db.hasTable('invocations'))) return null;

  // Resolve task_id for specialist sessions
  let taskId: string | null = null;
  if (!session.messaging_group_id && session.thread_id) {
    const row = (await db.get('SELECT id FROM specialist_tasks WHERE id = ?', session.thread_id)) as
      | { id: string }
      | undefined;
    if (row) taskId = row.id;
  }

  // End any orphaned active invocation for this session. This can happen when
  // the container close event doesn't fire (e.g. Apple Container), leaving the
  // previous invocation's ended_at NULL. Ending it now keeps getActiveInvocation
  // unambiguous and prevents placeTransferIntoActiveIpcIn from routing files to
  // a stale ipc-in directory on the next result delivery.
  const orphan = await getActiveInvocation(session.id);
  if (orphan) {
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
        await db.run("UPDATE transfer_files SET status = 'placed' WHERE id = ?", file.id);
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
      await db.run("UPDATE transfer_files SET status = 'placed' WHERE id = ?", file.id);
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
  const taskRow = (await db.get(
    `SELECT st.status
       FROM sessions s
       JOIN specialist_tasks st ON st.id = s.thread_id
       WHERE s.id = ? AND s.messaging_group_id IS NULL`,
    inv.session_id,
  )) as { status: string } | undefined;

  const taskAlive = taskRow != null && taskRow.status !== 'completed' && taskRow.status !== 'failed';

  if (taskAlive) {
    await db.run(
      `UPDATE transfer_files SET status = 'owned'
       WHERE transfer_id IN (
         SELECT id FROM container_transfers
         WHERE status = 'in_transit' AND recipient_session_id = ?
       )`,
      inv.session_id,
    );
    await db.run(
      "UPDATE container_transfers SET status = 'pending' WHERE status = 'in_transit' AND recipient_session_id = ?",
      inv.session_id,
    );
  } else {
    await db.run(
      `UPDATE transfer_files SET status = 'expired'
       WHERE transfer_id IN (
         SELECT id FROM container_transfers
         WHERE status = 'in_transit' AND recipient_session_id = ?
       )`,
      inv.session_id,
    );
    await db.run(
      "UPDATE container_transfers SET status = 'expired' WHERE status = 'in_transit' AND recipient_session_id = ?",
      inv.session_id,
    );
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
export async function expireTransfersForTerminalTask(taskId: string): Promise<void> {
  const db = getDb();
  if (!(await db.hasTable('container_transfers'))) return;

  // Expire transfers WHERE the delivering task's requester_task_id = taskId
  // (i.e. the delivery was for a sub-task of this task that became terminal)
  const transfersToExpire = (await db.all(
    `SELECT ct.id FROM container_transfers ct
       JOIN specialist_tasks st ON st.id = ct.task_id
       WHERE ct.status IN ('in_transit', 'committed')
         AND st.requester_task_id = ?`,
    taskId,
  )) as { id: string }[];

  for (const { id } of transfersToExpire) {
    await db.run("UPDATE transfer_files SET status = 'expired' WHERE transfer_id = ?", id);
    await db.run("UPDATE container_transfers SET status = 'expired' WHERE id = ?", id);
  }

  // Also expire pending transfers for the task itself that haven't been staged for delivery yet.
  // Transfers with recipient_session_id already set have been routed to an ipc-in dir and must
  // not be expired here — the delivery sweep will advance them to in_transit/committed.
  const pendingTransfers = (await db.all(
    "SELECT id FROM container_transfers WHERE task_id = ? AND status = 'pending' AND recipient_session_id IS NULL",
    taskId,
  )) as { id: string }[];

  for (const { id } of pendingTransfers) {
    await db.run("UPDATE transfer_files SET status = 'expired' WHERE transfer_id = ?", id);
    await db.run("UPDATE container_transfers SET status = 'expired' WHERE id = ?", id);
  }
}
