/**
 * The host's guarantee for named files (specs/specialists.allium
 * NamedFilesNeverLost): once a file named in a handover call is owned, it is
 * read by a recipient, committed to memory, handed back, or parked — never
 * discarded unseen. This module holds the two ways a file is handed back or
 * parked: a failed task gives back the files it was handed
 * (DispatchedFilesReturnedOnTaskFailed), and a transfer nobody can read any
 * more is copied into the root requester's workspace (TransferParked).
 * Refused dispatches give their files back through takeIpcOutFiles (kind
 * 'returned') in dispatch.ts.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { getTask } from './db.js';
import { hostStagingPath, reclaimTransferStaging } from './invocation.js';
import type { ContainerTransfer, SpecialistTask, TransferFile } from './types.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Where a transfer's file is in its recipient's container. */
function ipcInPath(transferId: string, name: string): string {
  return `${SPECIALISTS_CONFIG.ipcInContainerPath}/${transferId}/${name}`;
}

async function filesOf(transferId: string, status?: string): Promise<TransferFile[]> {
  return getDb().all<TransferFile>(
    `SELECT * FROM transfer_files WHERE transfer_id = ?${status ? ' AND status = ?' : ''}`,
    ...(status ? [transferId, status] : [transferId]),
  );
}

/** The group the root of a task chain was dispatched from: the main agent's. */
export async function rootGroupOfTask(taskId: string): Promise<string | null> {
  let task = await getTask(taskId);
  for (let hops = 0; task && task.requester_task_id && hops < 100; hops++) {
    task = await getTask(task.requester_task_id);
  }
  return task?.requester_group_id ?? null;
}

/** The root requester group a transfer belongs to (spec: root_requester_group). */
async function rootRequesterGroupId(t: ContainerTransfer): Promise<string | null> {
  if (t.kind !== 'returned') return t.task_id ? rootGroupOfTask(t.task_id) : null;
  if (t.failed_task_id) return rootGroupOfTask(t.failed_task_id);
  if (!t.recipient_session_id) return null;
  const session = (await getDb().get(
    'SELECT agent_group_id, thread_id FROM sessions WHERE id = ?',
    t.recipient_session_id,
  )) as { agent_group_id: string; thread_id: string | null } | undefined;
  if (!session) return null;
  if (session.thread_id) {
    const task = await getTask(session.thread_id);
    if (task && task.specialist_group_id === session.agent_group_id) return rootGroupOfTask(task.id);
  }
  return session.agent_group_id;
}

/**
 * Park a transfer whose files can no longer reach anyone (spec:
 * TransferParked): copy each unretired file into the root requester group's
 * `handover-orphans/<transfer>/`, record where, and retire the transfer. Only
 * when that group is gone are the files dropped. Parking is logged; no agent
 * is told.
 */
export async function parkTransfer(transferId: string, reason: string): Promise<void> {
  const db = getDb();
  const t = (await db.get('SELECT * FROM container_transfers WHERE id = ?', transferId)) as
    | ContainerTransfer
    | undefined;
  if (!t || (t.status !== 'pending' && t.status !== 'in_transit')) return;

  const groupId = await rootRequesterGroupId(t);
  const group = groupId ? await getAgentGroup(groupId) : undefined;
  const parked: Array<{ id: string; parkedPath: string | null }> = [];
  const stuck: string[] = [];
  for (const f of await filesOf(transferId)) {
    if (f.status === 'expired') continue;
    if (!group) {
      parked.push({ id: f.id, parkedPath: null });
      continue;
    }
    // A staged copy already gone (reclaimed elsewhere, lost with the disk)
    // leaves nothing to keep or park.
    if (!fs.existsSync(f.host_path)) {
      log.error('specialists: a transferred file has no staged copy left to park', {
        transferId,
        file: f.original_name,
      });
      parked.push({ id: f.id, parkedPath: null });
      continue;
    }
    const rel = `${SPECIALISTS_CONFIG.orphanSubpath}/${transferId}/${f.original_name}`;
    try {
      const dest = path.join(GROUPS_DIR, group.folder, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.host_path, dest);
      parked.push({ id: f.id, parkedPath: rel });
    } catch (err) {
      log.error('specialists: could not park a transferred file — keeping its staged copy', {
        transferId,
        file: f.original_name,
        err,
      });
      stuck.push(f.original_name);
    }
  }
  // A file that could not be parked is not retired: its staged copy stays,
  // and with it the transfer, so nothing named is dropped unseen
  // (NamedFilesNeverLost). The transfer keeps its status for a later look.
  await db.transaction(async () => {
    for (const { id, parkedPath } of parked) {
      await db.run("UPDATE transfer_files SET status = 'expired', parked_path = ? WHERE id = ?", parkedPath, id);
    }
    if (stuck.length === 0) await db.run("UPDATE container_transfers SET status = 'expired' WHERE id = ?", transferId);
  });
  if (stuck.length === 0) reclaimTransferStaging(transferId);
  if (group) {
    log.warn('specialists: parked files no recipient could read', {
      transferId,
      reason,
      group: group.folder,
      files: parked.map((p) => p.parkedPath),
      ...(stuck.length > 0 ? { notParked: stuck } : {}),
    });
  } else {
    log.warn('specialists: dropped transferred files — their root requester group is gone', {
      transferId,
      reason,
      files: parked.length,
    });
  }
}

/**
 * A failed task gives back the files it was handed at dispatch (spec:
 * DispatchedFilesReturnedOnTaskFailed): copied into a returned transfer to
 * the session that dispatched it, the dispatch transfer retired. Returns the
 * returned transfer, or null when there was nothing to give back.
 */
export async function returnDispatchedFiles(
  task: SpecialistTask,
  returnTo: string = task.requester_session_id,
): Promise<ContainerTransfer | null> {
  const db = getDb();
  if (!(await db.hasTable('container_transfers'))) return null;
  const given = (await db.get(
    "SELECT * FROM container_transfers WHERE kind = 'dispatch' AND task_id = ? AND status IN ('pending', 'in_transit')",
    task.id,
  )) as ContainerTransfer | undefined;
  if (!given) return null;

  const backId = genId('xfer');
  const copies: Array<{ id: string; name: string; hostPath: string }> = [];
  for (const f of await filesOf(given.id)) {
    const dest = hostStagingPath(backId, f.original_name);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.host_path, dest);
      copies.push({ id: genId('tfile'), name: f.original_name, hostPath: dest });
    } catch (err) {
      log.error('specialists: could not copy a file to return it', { taskId: task.id, file: f.original_name, err });
    }
  }
  if (copies.length === 0) {
    await parkTransfer(given.id, 'its task failed and its files could not be copied back');
    return null;
  }

  const back: ContainerTransfer = {
    id: backId,
    kind: 'returned',
    task_id: null,
    sender_invocation_id: given.sender_invocation_id,
    result_text: '',
    commit_to_memory: 0,
    file_count: copies.length,
    sent_at: new Date().toISOString(),
    status: 'pending',
    recipient_session_id: returnTo,
    routed_message_id: null,
    failed_task_id: task.id,
    returned_as: null,
  };
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO container_transfers
         (id, kind, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status,
          recipient_session_id, routed_message_id, failed_task_id, returned_as)
       VALUES
         (@id, @kind, @task_id, @sender_invocation_id, @result_text, @commit_to_memory, @file_count, @sent_at, @status,
          @recipient_session_id, @routed_message_id, @failed_task_id, @returned_as)`,
      back,
    );
    for (const c of copies) {
      await db.run(
        `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path, parked_path, reached_recipient)
         VALUES (?, ?, ?, ?, 'owned', NULL, NULL, 0)`,
        c.id,
        backId,
        c.name,
        c.hostPath,
      );
    }
    await db.run("UPDATE transfer_files SET status = 'expired' WHERE transfer_id = ?", given.id);
    await db.run("UPDATE container_transfers SET status = 'expired', returned_as = ? WHERE id = ?", backId, given.id);
  });
  reclaimTransferStaging(given.id);
  log.info('specialists: files handed to a failed task returned to its dispatcher', {
    taskId: task.id,
    transferId: backId,
    sessionId: returnTo,
    files: copies.length,
  });
  return back;
}

/** "[Files returned to you: …]" for a message that hands a transfer back. */
export async function returnedNote(transfer: ContainerTransfer, lead: string): Promise<string> {
  const files = await filesOf(transfer.id);
  if (files.length === 0) return '';
  return `\n\n[${lead}: ${files.map((f) => ipcInPath(transfer.id, f.original_name)).join(', ')}]`;
}

/**
 * Files given back to a session that are still waiting for it, for the
 * prompt that restarts it: a parent restarting after a crash may have had a
 * failed child's files returned while it was down, with nothing else to say
 * they are there.
 */
export async function waitingFilesNote(sessionId: string): Promise<string> {
  const db = getDb();
  if (!(await db.hasTable('container_transfers'))) return '';
  const waiting = await db.all<{ id: string }>(
    "SELECT id FROM container_transfers WHERE kind = 'returned' AND recipient_session_id = ? AND status IN ('pending', 'in_transit')",
    sessionId,
  );
  const paths: string[] = [];
  for (const t of waiting) {
    for (const f of await filesOf(t.id)) paths.push(ipcInPath(t.id, f.original_name));
  }
  return paths.length > 0 ? `\n\n[Files returned to you, in your ipc-in: ${paths.join(', ')}]` : '';
}
