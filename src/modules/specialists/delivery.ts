/**
 * deliver_specialist_result system-action handler.
 * Called when the specialist container writes a deliver_specialist_result
 * system action to its outbound DB. Marks the task completed, then routes
 * the result to the requester.
 *
 * Supports optional file_paths and commit_to_memory for the IPC file-handover
 * feature. When the invocations table is absent (migration not yet applied),
 * file_paths is ignored and only result_text is routed.
 */
import path from 'path';
import fs from 'fs';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getRunningTaskForGroup, updateTaskStatus } from './db.js';
import { routeResult } from './routing.js';
import { getActiveInvocation, hostStagingPath, TRANSFERS_BASE_DIR } from './invocation.js';
import { SPECIALISTS_CONFIG } from './config.js';
import type { ContainerTransfer, TransferFile } from './types.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleDeliverSpecialistResult(content: Record<string, unknown>, session: Session): Promise<void> {
  const resultText = content.result_text as string | undefined;

  if (!resultText) {
    log.warn('specialists: deliver_specialist_result missing result_text', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const task = getRunningTaskForGroup(session.agent_group_id);
  if (!task) {
    log.warn('specialists: deliver_specialist_result — no live task for agent group', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }
  // Accept queued/running/awaiting_restart: a fast container may deliver before
  // the 60s recovery sweep has advanced the status to 'running'.
  if (!['queued', 'running', 'awaiting_restart'].includes(task.status)) {
    log.warn('specialists: deliver_specialist_result — task not in a deliverable state', {
      taskId: task.id,
      status: task.status,
    });
    return;
  }

  const filePaths = (content.file_paths as string[] | undefined) ?? [];
  const commitToMemory = Boolean(content.commit_to_memory);

  // Sub-task commit_to_memory degradation: only root tasks (requester_group_id set)
  // can commit to memory. Sub-tasks silently degrade to false.
  const effectiveCommit = commitToMemory && task.requester_group_id != null;

  const now = new Date().toISOString();
  updateTaskStatus(task.id, 'completed', {
    result: resultText,
    closed_at: now,
  });

  const completed = { ...task, status: 'completed' as const, result: resultText, closed_at: now };

  // Build a ContainerTransfer when files are present and the tables exist
  let transfer: ContainerTransfer | null = null;

  if (filePaths.length > 0 && hasTable(getDb(), 'invocations')) {
    transfer = _buildTransfer(session, completed.id, resultText, filePaths, effectiveCommit);
  }

  await routeResult(completed, transfer);

  log.info('specialists: task completed', { taskId: task.id, agentGroupId: session.agent_group_id });
}

/**
 * Copy files from ipc-out to host staging and create ContainerTransfer +
 * TransferFile rows. Returns the ContainerTransfer (status='pending') or
 * null if the invocation or any precondition is missing.
 */
function _buildTransfer(
  session: Session,
  taskId: string,
  resultText: string,
  filePaths: string[],
  commitToMemory: boolean,
): ContainerTransfer | null {
  const db = getDb();

  const invocation = getActiveInvocation(session.id);
  if (!invocation) {
    log.warn('specialists: no active invocation for session — skipping file transfer', {
      sessionId: session.id,
      taskId,
    });
    return null;
  }

  const transferId = genId('xfer');
  const now = new Date().toISOString();

  // Rewrite result_text paths and copy files to staging
  const transferFiles: Array<{ id: string; originalName: string; hostPath: string }> = [];
  let rewrittenText = resultText;

  const stagingDir = path.join(TRANSFERS_BASE_DIR, transferId);
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const containerPath of filePaths) {
    const basename = path.basename(containerPath);

    // Map container path -> host path via ipc-out
    const ipcOutContainerPath = SPECIALISTS_CONFIG.ipcOutContainerPath;
    let relPath: string;
    if (containerPath.startsWith(ipcOutContainerPath + '/')) {
      relPath = containerPath.slice(ipcOutContainerPath.length + 1);
    } else if (containerPath.startsWith(ipcOutContainerPath)) {
      relPath = containerPath.slice(ipcOutContainerPath.length);
    } else {
      relPath = basename;
    }
    const hostSrcPath = path.join(invocation.ipc_out_host_path, relPath);
    const destPath = hostStagingPath(transferId, basename);

    try {
      fs.copyFileSync(hostSrcPath, destPath);
    } catch (err) {
      log.warn('specialists: failed to copy file from ipc-out to staging', {
        src: hostSrcPath,
        dest: destPath,
        err,
      });
      // Skip this file
      continue;
    }

    const fileId = genId('tfile');
    transferFiles.push({ id: fileId, originalName: basename, hostPath: destPath });

    // Rewrite path in result_text
    if (commitToMemory) {
      const memPath = `${SPECIALISTS_CONFIG.memoryReportsSubpath}/${basename}`;
      rewrittenText = rewrittenText.split(containerPath).join(memPath);
    } else {
      const ipcInPath = `${SPECIALISTS_CONFIG.ipcInContainerPath}/${transferId}/${basename}`;
      rewrittenText = rewrittenText.split(containerPath).join(ipcInPath);
    }
  }

  if (transferFiles.length === 0) {
    // All files failed to copy — no transfer
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    return null;
  }

  // Insert ContainerTransfer
  const transfer: ContainerTransfer = {
    id: transferId,
    task_id: taskId,
    sender_invocation_id: invocation.id,
    result_text: rewrittenText,
    commit_to_memory: commitToMemory ? 1 : 0,
    file_count: transferFiles.length,
    sent_at: now,
    status: 'pending',
    recipient_session_id: null,
  };

  db.prepare(
    `INSERT INTO container_transfers
       (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
     VALUES
       (@id, @task_id, @sender_invocation_id, @result_text, @commit_to_memory, @file_count, @sent_at, @status, @recipient_session_id)`,
  ).run(transfer);

  // Insert TransferFile rows
  for (const f of transferFiles) {
    const tfRow: TransferFile = {
      id: f.id,
      transfer_id: transferId,
      original_name: f.originalName,
      host_path: f.hostPath,
      status: 'owned',
      memory_path: null,
    };
    db.prepare(
      `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
       VALUES (@id, @transfer_id, @original_name, @host_path, @status, @memory_path)`,
    ).run(tfRow);
  }

  log.debug('specialists: ContainerTransfer created', {
    transferId,
    taskId,
    fileCount: transferFiles.length,
    commitToMemory,
  });

  return transfer;
}
