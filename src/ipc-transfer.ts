/**
 * Host-side helpers for the container IPC transfer lifecycle.
 *
 * Phase 2: DB-backed operations (expiry, rejection errors).
 * File operations (takeFileOwnership, placeFilesForInvocation) are added
 * in Phase 3 once the ipc-out/ipc-in mounts exist.
 */

import { expireTransfersForTask as dbExpireTransfersForTask } from './db.js';

export interface RejectionError {
  error: 'ContainerSendRejected';
  missing_paths: string[];
  available_paths: string[];
}

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
 * Expire all in_transit transfers (and their files) associated with a
 * specialist task that has reached a terminal state.
 * Delegates to the DB layer; exported here so callers only need to import
 * from ipc-transfer.
 */
export function expireTransfersForTask(taskId: string): void {
  dbExpireTransfersForTask(taskId);
}
