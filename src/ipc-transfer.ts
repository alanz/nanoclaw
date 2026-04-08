/**
 * Host-side helpers for the container IPC transfer lifecycle.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  createContainerTransfer,
  createTransferFile,
  expireTransfersForTask as dbExpireTransfersForTask,
  getTransferFilesByTransfer,
  getTransfersByRecipientTask,
  updateContainerTransfer,
  updateTransferFile,
} from './db.js';
import { logger } from './logger.js';
import { ContainerTransfer, TransferFile } from './types.js';

export interface RejectionError {
  error: 'ContainerSendRejected';
  missing_paths: string[];
  available_paths: string[];
}

export type TakeOwnershipResult =
  | { ok: true; transfer: ContainerTransfer; files: TransferFile[] }
  | { ok: false; error: RejectionError };

/**
 * Build a structured rejection error when a container tries to send files
 * that are not present in its ipc-out directory.
 */
export function buildRejectionError(
  missingPaths: string[],
  availablePaths: string[],
): RejectionError {
  return {
    error: 'ContainerSendRejected',
    missing_paths: missingPaths,
    available_paths: availablePaths,
  };
}

/**
 * Take ownership of staged files from a container's ipc-out directory.
 *
 * Validates all requested paths exist in the invocation's ipc-out dir, copies
 * them to host-managed storage at DATA_DIR/transfers/{transferId}/{filename},
 * creates DB records, and returns the transfer.
 *
 * Returns a RejectionError if any requested files are missing.
 * Pass _dataDir to override DATA_DIR in tests.
 */
export function takeFileOwnership(opts: {
  invocationId: string;
  /** Container-relative paths, e.g. /workspace/ipc-out/report.md */
  filePaths: string[];
  message: string;
  recipientTaskId: string | null;
  recipientGroupFolder: string | null;
  senderGroupFolder: string;
  _dataDir?: string;
}): TakeOwnershipResult {
  const dataDir = opts._dataDir ?? DATA_DIR;
  const ipcOutDir = path.join(
    dataDir,
    'invocations',
    opts.invocationId,
    'ipc-out',
  );

  const IPC_OUT_PREFIX = '/workspace/ipc-out/';
  const resolved: Array<{ hostPath: string; name: string }> = [];
  const missing: string[] = [];

  for (const containerPath of opts.filePaths) {
    if (!containerPath.startsWith(IPC_OUT_PREFIX)) continue;
    const name = path.basename(containerPath);
    const hostPath = path.join(ipcOutDir, name);
    if (!fs.existsSync(hostPath)) {
      missing.push(containerPath);
    } else {
      resolved.push({ hostPath, name });
    }
  }

  if (missing.length > 0) {
    let available: string[] = [];
    try {
      available = fs.readdirSync(ipcOutDir).map((f) => `${IPC_OUT_PREFIX}${f}`);
    } catch {
      // ipc-out dir may not exist yet
    }
    return { ok: false, error: buildRejectionError(missing, available) };
  }

  const transferId = crypto.randomUUID();
  const now = new Date().toISOString();

  const transfer: ContainerTransfer = {
    id: transferId,
    sender_invocation_id: opts.invocationId,
    sender_group_folder: opts.senderGroupFolder,
    message: opts.message,
    file_count: resolved.length,
    sent_at: now,
    status: 'pending',
    recipient_task_id: opts.recipientTaskId,
    recipient_group_folder: opts.recipientGroupFolder,
  };
  createContainerTransfer(transfer);

  const transferDir = path.join(dataDir, 'transfers', transferId);
  fs.mkdirSync(transferDir, { recursive: true });

  const files: TransferFile[] = [];
  for (const { hostPath, name } of resolved) {
    const destPath = path.join(transferDir, name);
    fs.copyFileSync(hostPath, destPath);
    const file: TransferFile = {
      id: crypto.randomUUID(),
      transfer_id: transferId,
      original_name: name,
      host_path: destPath,
      status: 'owned',
    };
    createTransferFile(file);
    files.push(file);
  }

  logger.info(
    {
      transferId,
      fileCount: files.length,
      recipientTaskId: opts.recipientTaskId,
    },
    'File ownership taken',
  );

  return { ok: true, transfer, files };
}

/**
 * Place owned transfer files into a container's ipc-in directory before it
 * starts. Looks up all pending/in_transit transfers targeting taskId, copies
 * owned files to DATA_DIR/invocations/{invocationId}/ipc-in/{transferId}/{name},
 * and marks them 'placed'.
 *
 * Pass _dataDir to override DATA_DIR in tests.
 */
export function placeFilesForInvocation(
  taskId: string,
  invocationId: string,
  _dataDir?: string,
): void {
  const dataDir = _dataDir ?? DATA_DIR;
  const transfers = getTransfersByRecipientTask(taskId);

  for (const transfer of transfers) {
    const ownedFiles = getTransferFilesByTransfer(transfer.id).filter(
      (f) => f.status === 'owned',
    );
    if (ownedFiles.length === 0) continue;

    const destDir = path.join(
      dataDir,
      'invocations',
      invocationId,
      'ipc-in',
      transfer.id,
    );
    fs.mkdirSync(destDir, { recursive: true });

    for (const file of ownedFiles) {
      const destPath = path.join(destDir, file.original_name);
      try {
        fs.copyFileSync(file.host_path, destPath);
        updateTransferFile(file.id, { status: 'placed', host_path: destPath });
      } catch (err) {
        logger.warn(
          { fileId: file.id, hostPath: file.host_path, err },
          'Failed to place transfer file in ipc-in',
        );
      }
    }

    updateContainerTransfer(transfer.id, { status: 'in_transit' });
    logger.info(
      { transferId: transfer.id, invocationId, fileCount: ownedFiles.length },
      'Transfer files placed in ipc-in',
    );
  }
}

/**
 * Expire all in_transit transfers (and their files) associated with a
 * specialist task that has reached a terminal state.
 */
export function expireTransfersForTask(taskId: string): void {
  dbExpireTransfersForTask(taskId);
}
