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
import { getDb } from '../../db/connection.js';
import { getLiveTaskForSession, updateTaskStatus } from './db.js';
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

  const task = await getLiveTaskForSession(session);
  if (!task) {
    log.warn('specialists: deliver_specialist_result — no live task for this session', {
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
      threadId: session.thread_id,
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

  // Build the ContainerTransfer first: a file it refuses is noted in the
  // result the requester reads, rather than silently missing.
  let transfer: ContainerTransfer | null = null;
  let refused: RefusedFile[] = [];
  if (filePaths.length > 0 && (await getDb().hasTable('invocations'))) {
    ({ transfer, refused } = await _buildTransfer(session, task.id, resultText, filePaths, effectiveCommit));
  }
  const finalText = resultText + refusalNote(refused);

  const now = new Date().toISOString();
  await updateTaskStatus(task.id, 'completed', {
    result: finalText,
    closed_at: now,
  });

  const completed = { ...task, status: 'completed' as const, result: finalText, closed_at: now };

  await routeResult(completed, transfer);

  log.info('specialists: task completed', { taskId: task.id, agentGroupId: session.agent_group_id });
}

interface RefusedFile {
  path: string;
  reason: string;
}

function refusalNote(refused: RefusedFile[]): string {
  if (refused.length === 0) return '';
  return `\n\n[Not delivered: ${refused.map((f) => `${f.path} (${f.reason})`).join('; ')}]`;
}

/**
 * Resolve a path the specialist listed to a file on the host, or say why not.
 *
 * Only files inside the invocation's ipc-out leave the container. The host
 * copies with its own privileges, so a path that escapes ipc-out (`..`, or an
 * absolute path elsewhere) or a symlink placed in it would otherwise copy any
 * host file the host can read into the requester's workspace. The real path
 * must be exactly the path inside the real ipc-out: any symlink along the way
 * makes them differ.
 */
export function resolveIpcOutFile(
  ipcOutHostPath: string,
  containerPath: string,
): { hostPath: string } | { error: string } {
  const prefix = SPECIALISTS_CONFIG.ipcOutContainerPath;
  const normalized = path.posix.normalize(containerPath);
  let rel: string;
  if (normalized.startsWith(prefix + '/')) rel = normalized.slice(prefix.length + 1);
  else if (!path.posix.isAbsolute(normalized)) rel = normalized;
  else return { error: `not in ${prefix} — copy it there first` };
  if (!rel || rel === '.' || rel.split('/').includes('..')) return { error: `outside ${prefix}` };

  let root: string;
  try {
    root = fs.realpathSync(ipcOutHostPath);
  } catch {
    return { error: 'no ipc-out for this run' };
  }
  const hostPath = path.join(root, ...rel.split('/'));
  let real: string;
  try {
    real = fs.realpathSync(hostPath);
  } catch {
    return { error: 'no such file' };
  }
  if (real !== hostPath) return { error: 'is or passes through a symbolic link' };
  if (!fs.lstatSync(hostPath).isFile()) return { error: 'not a regular file' };
  return { hostPath };
}

/**
 * Copy without following a symlink swapped in after resolveIpcOutFile looked
 * (the container is still running while this happens).
 */
function copyNoFollow(src: string, dest: string): void {
  const fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file');
    fs.writeFileSync(dest, fs.readFileSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy files from ipc-out to host staging and create ContainerTransfer +
 * TransferFile rows. Returns the ContainerTransfer (status='pending'), or null
 * if the invocation is missing or no file could be taken, plus the files it
 * refused and why.
 */
async function _buildTransfer(
  session: Session,
  taskId: string,
  resultText: string,
  filePaths: string[],
  commitToMemory: boolean,
): Promise<{ transfer: ContainerTransfer | null; refused: RefusedFile[] }> {
  const db = getDb();
  const refused: RefusedFile[] = [];

  const invocation = await getActiveInvocation(session.id);
  if (!invocation) {
    log.warn('specialists: no active invocation for session — skipping file transfer', {
      sessionId: session.id,
      taskId,
    });
    return { transfer: null, refused: filePaths.map((p) => ({ path: p, reason: 'no ipc-out for this run' })) };
  }

  const transferId = genId('xfer');
  const now = new Date().toISOString();

  // Rewrite result_text paths and copy files to staging
  const transferFiles: Array<{ id: string; originalName: string; hostPath: string }> = [];
  let rewrittenText = resultText;

  const stagingDir = path.join(TRANSFERS_BASE_DIR, transferId);
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const containerPath of filePaths) {
    const basename = path.posix.basename(containerPath);

    const resolved = resolveIpcOutFile(invocation.ipc_out_host_path, containerPath);
    if ('error' in resolved) {
      log.warn('specialists: refused a delivered file', { taskId, path: containerPath, reason: resolved.error });
      refused.push({ path: containerPath, reason: resolved.error });
      continue;
    }
    const destPath = hostStagingPath(transferId, basename);

    try {
      copyNoFollow(resolved.hostPath, destPath);
    } catch (err) {
      log.warn('specialists: failed to copy file from ipc-out to staging', {
        src: resolved.hostPath,
        dest: destPath,
        err,
      });
      refused.push({ path: containerPath, reason: 'could not be read' });
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
    return { transfer: null, refused };
  }

  // The requester reads this text; say what did not come through.
  rewrittenText += refusalNote(refused);

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

  await db.run(
    `INSERT INTO container_transfers
       (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
     VALUES
       (@id, @task_id, @sender_invocation_id, @result_text, @commit_to_memory, @file_count, @sent_at, @status, @recipient_session_id)`,
    transfer,
  );

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
    await db.run(
      `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
       VALUES (@id, @transfer_id, @original_name, @host_path, @status, @memory_path)`,
      tfRow,
    );
  }

  log.debug('specialists: ContainerTransfer created', {
    transferId,
    taskId,
    fileCount: transferFiles.length,
    commitToMemory,
  });

  return { transfer, refused };
}
