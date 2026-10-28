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
import type { ContainerTransfer, TransferFile, TransferKind } from './types.js';

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
  // A fast container may deliver before the 60s recovery sweep has advanced
  // its task to running. The delivery itself proves the container is up, so
  // the task passes through running first, as a dispatch_sub_task call does.
  if (task.status === 'queued' || task.status === 'awaiting_restart') {
    log.info('specialists: task advanced to running by its own delivery', { taskId: task.id, from: task.status });
    await updateTaskStatus(task.id, 'running');
    task.status = 'running';
  }
  if (task.status !== 'running') {
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
    ({ transfer, refused } = await takeIpcOutFiles(session, {
      kind: 'result',
      taskId: task.id,
      text: resultText,
      filePaths,
      commitToMemory: effectiveCommit,
      recipientSessionId: null,
    }));
  }
  // The text the requester reads: path-rewritten, with any refusal note.
  const finalText = transfer ? transfer.result_text : resultText + refusalNote(refused);

  const now = new Date().toISOString();
  await updateTaskStatus(task.id, 'completed', {
    result: finalText,
    closed_at: now,
  });

  const completed = { ...task, status: 'completed' as const, result: finalText, closed_at: now };

  await routeResult(completed, transfer);

  log.info('specialists: task completed', { taskId: task.id, agentGroupId: session.agent_group_id });
}

export interface RefusedFile {
  path: string;
  reason: string;
}

export function refusalNote(refused: RefusedFile[]): string {
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

/** Where a delivered file is for the requester: its memory path, or its ipc-in path. */
function deliveredPath(name: string, transferId: string, commitToMemory: boolean): string {
  return commitToMemory
    ? `${SPECIALISTS_CONFIG.memoryReportsSubpath}/${name}`
    : `${SPECIALISTS_CONFIG.ipcInContainerPath}/${transferId}/${name}`;
}

/** `name`, or `name` numbered before its extension (report-2.md) if taken. */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const ext = path.posix.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Map a listed path, and the absolute ipc-out form of it, to where the file went. */
function addRewrites(rewrites: Map<string, string>, containerPath: string, to: string): void {
  const prefix = SPECIALISTS_CONFIG.ipcOutContainerPath;
  const normalized = path.posix.normalize(containerPath);
  const rel = normalized.startsWith(prefix + '/') ? normalized.slice(prefix.length + 1) : normalized;
  rewrites.set(containerPath, to);
  rewrites.set(`${prefix}/${rel}`, to);
}

/**
 * Rewrite every listed path in one pass, longest first, so a relative path is
 * never rewritten inside the absolute form of itself (or of another file).
 */
function rewritePaths(text: string, rewrites: Map<string, string>): string {
  if (rewrites.size === 0) return text;
  const pattern = [...rewrites.keys()]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), (match) => rewrites.get(match) ?? match);
}

export interface TakeFilesOptions {
  kind: TransferKind;
  /** result: the delivering task. dispatch: the task the files go to. */
  taskId: string;
  /** Text whose references to the listed paths are rewritten to where the files went. */
  text: string;
  filePaths: string[];
  commitToMemory: boolean;
  /** Known up front for a dispatch (the new task's session); set at routing for a result. */
  recipientSessionId: string | null;
}

export interface TakenFiles {
  /** Null when the invocation is missing or no file could be taken. */
  transfer: ContainerTransfer | null;
  refused: RefusedFile[];
  /** `text` with the listed paths rewritten; no refusal note. */
  text: string;
  /** Where each taken file is for its recipient, in the order listed. */
  placed: string[];
}

/**
 * Copy files from the session's ipc-out to host staging and create the
 * ContainerTransfer (status='pending') + TransferFile rows: a specialist's
 * delivery (kind result) or the files a dispatcher hands to the task it
 * dispatches (kind dispatch). A path that cannot be taken is refused, with
 * the reason, rather than failing the call.
 */
export async function takeIpcOutFiles(session: Session, opts: TakeFilesOptions): Promise<TakenFiles> {
  const { kind, taskId, filePaths, commitToMemory } = opts;
  const db = getDb();
  const refused: RefusedFile[] = [];

  const invocation = await getActiveInvocation(session.id);
  if (!invocation) {
    log.warn('specialists: no active invocation for session — skipping file transfer', {
      sessionId: session.id,
      taskId,
    });
    return {
      transfer: null,
      refused: filePaths.map((p) => ({ path: p, reason: 'no ipc-out for this run' })),
      text: opts.text,
      placed: [],
    };
  }

  const transferId = genId('xfer');
  const now = new Date().toISOString();

  // Copy files to staging; collect how each path is rewritten in result_text
  const transferFiles: Array<{ id: string; originalName: string; hostPath: string }> = [];
  const placed: string[] = [];
  const rewrites = new Map<string, string>();
  // Each file once, under a name unique in this transfer (the spec's
  // IpcInPathsUniquePerTransfer): staging and ipc-in are keyed by name.
  const delivered = new Map<string, string>(); // host path -> name it went under
  const names = new Set<string>();

  const stagingDir = path.join(TRANSFERS_BASE_DIR, transferId);
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const containerPath of filePaths) {
    const resolved = resolveIpcOutFile(invocation.ipc_out_host_path, containerPath);
    if ('error' in resolved) {
      log.warn('specialists: refused a file', { kind, taskId, path: containerPath, reason: resolved.error });
      refused.push({ path: containerPath, reason: resolved.error });
      continue;
    }
    const already = delivered.get(resolved.hostPath);
    if (already !== undefined) {
      addRewrites(rewrites, containerPath, deliveredPath(already, transferId, commitToMemory));
      continue;
    }
    const basename = uniqueName(path.posix.basename(containerPath), names);
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
    delivered.set(resolved.hostPath, basename);
    names.add(basename);
    placed.push(deliveredPath(basename, transferId, commitToMemory));
    addRewrites(rewrites, containerPath, deliveredPath(basename, transferId, commitToMemory));
  }

  const rewrittenText = rewritePaths(opts.text, rewrites);

  if (transferFiles.length === 0) {
    // All files failed to copy — no transfer
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    return { transfer: null, refused, text: rewrittenText, placed };
  }

  // Insert ContainerTransfer. A result's requester reads its text, so it
  // says what did not come through; a dispatch's text is the task's prompt,
  // which its caller records on the task.
  const transfer: ContainerTransfer = {
    id: transferId,
    kind,
    task_id: taskId,
    sender_invocation_id: invocation.id,
    result_text: kind === 'result' ? rewrittenText + refusalNote(refused) : '',
    commit_to_memory: commitToMemory ? 1 : 0,
    file_count: transferFiles.length,
    sent_at: now,
    status: 'pending',
    recipient_session_id: opts.recipientSessionId,
  };

  await db.run(
    `INSERT INTO container_transfers
       (id, kind, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
     VALUES
       (@id, @kind, @task_id, @sender_invocation_id, @result_text, @commit_to_memory, @file_count, @sent_at, @status, @recipient_session_id)`,
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
    kind,
    taskId,
    fileCount: transferFiles.length,
    commitToMemory,
  });

  return { transfer, refused, text: rewrittenText, placed };
}
