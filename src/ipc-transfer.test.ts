import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  createContainerTransfer,
  createTransferFile,
  getContainerTransfer,
  getTransferFilesByTransfer,
} from './db.js';
import {
  buildRejectionError,
  expireTransfersForTask,
  placeFilesForInvocation,
  takeFileOwnership,
} from './ipc-transfer.js';

let tmpDir: string;

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-transfer-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildRejectionError
// ---------------------------------------------------------------------------

describe('buildRejectionError', () => {
  it('returns a ContainerSendRejected error with missing and available paths', () => {
    const err = buildRejectionError(
      ['/workspace/ipc-out/a.md', '/workspace/ipc-out/b.md'],
      ['/workspace/ipc-out/c.md'],
    );
    expect(err.error).toBe('ContainerSendRejected');
    expect(err.missing_paths).toEqual([
      '/workspace/ipc-out/a.md',
      '/workspace/ipc-out/b.md',
    ]);
    expect(err.available_paths).toEqual(['/workspace/ipc-out/c.md']);
  });

  it('returns empty arrays when nothing is missing or available', () => {
    const err = buildRejectionError([], []);
    expect(err.missing_paths).toHaveLength(0);
    expect(err.available_paths).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// expireTransfersForTask
// ---------------------------------------------------------------------------

describe('expireTransfersForTask', () => {
  it('expires in_transit transfers and their files via DB', () => {
    createContainerTransfer({
      id: 'xfer-1',
      sender_invocation_id: 'inv-1',
      sender_group_folder: 'main',
      message: 'results',
      file_count: 1,
      sent_at: '2024-01-01T00:00:00.000Z',
      status: 'in_transit',
      recipient_task_id: 'task-1',
      recipient_group_folder: null,
    });
    createTransferFile({
      id: 'file-1',
      transfer_id: 'xfer-1',
      original_name: 'out.md',
      host_path: '/data/transfers/xfer-1/out.md',
      status: 'placed',
    });

    expireTransfersForTask('task-1');

    expect(getContainerTransfer('xfer-1')!.status).toBe('expired');
    expect(getTransferFilesByTransfer('xfer-1')[0].status).toBe('expired');
  });

  it('does not expire transfers for other tasks', () => {
    createContainerTransfer({
      id: 'xfer-2',
      sender_invocation_id: 'inv-2',
      sender_group_folder: 'main',
      message: 'other',
      file_count: 0,
      sent_at: '2024-01-01T00:00:00.000Z',
      status: 'in_transit',
      recipient_task_id: 'task-other',
      recipient_group_folder: null,
    });

    expireTransfersForTask('task-1');

    expect(getContainerTransfer('xfer-2')!.status).toBe('in_transit');
  });
});

// ---------------------------------------------------------------------------
// takeFileOwnership
// ---------------------------------------------------------------------------

function makeIpcOut(invocationId: string, files: Record<string, string>): void {
  const dir = path.join(tmpDir, 'invocations', invocationId, 'ipc-out');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

describe('takeFileOwnership', () => {
  it('copies files to host-managed storage and creates DB records', () => {
    makeIpcOut('inv-1', { 'report.md': '# Report' });

    const result = takeFileOwnership({
      invocationId: 'inv-1',
      filePaths: ['/workspace/ipc-out/report.md'],
      message: 'here is the report',
      recipientTaskId: 'task-1',
      recipientGroupFolder: null,
      senderGroupFolder: 'main',
      _dataDir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // DB records created
    expect(getContainerTransfer(result.transfer.id)).toBeDefined();
    expect(result.files).toHaveLength(1);
    expect(result.files[0].original_name).toBe('report.md');
    expect(result.files[0].status).toBe('owned');

    // File copied to host-managed storage
    expect(fs.existsSync(result.files[0].host_path)).toBe(true);
    expect(fs.readFileSync(result.files[0].host_path, 'utf-8')).toBe(
      '# Report',
    );
  });

  it('returns rejection error when a file is missing', () => {
    makeIpcOut('inv-1', { 'other.md': 'x' });

    const result = takeFileOwnership({
      invocationId: 'inv-1',
      filePaths: ['/workspace/ipc-out/report.md'],
      message: 'missing',
      recipientTaskId: 'task-1',
      recipientGroupFolder: null,
      senderGroupFolder: 'main',
      _dataDir: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe('ContainerSendRejected');
    expect(result.error.missing_paths).toContain(
      '/workspace/ipc-out/report.md',
    );
    expect(result.error.available_paths).toContain(
      '/workspace/ipc-out/other.md',
    );
  });

  it('handles multiple files in a single transfer', () => {
    makeIpcOut('inv-2', { 'a.md': 'A', 'b.md': 'B' });

    const result = takeFileOwnership({
      invocationId: 'inv-2',
      filePaths: ['/workspace/ipc-out/a.md', '/workspace/ipc-out/b.md'],
      message: 'two files',
      recipientTaskId: null,
      recipientGroupFolder: 'main',
      senderGroupFolder: 'spec-123',
      _dataDir: tmpDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// placeFilesForInvocation
// ---------------------------------------------------------------------------

describe('placeFilesForInvocation', () => {
  it('copies owned files to ipc-in and marks them placed', () => {
    // Set up a transfer with an owned file on disk
    const srcFile = path.join(tmpDir, 'transfers', 'xfer-1', 'report.md');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, '# Report');

    createContainerTransfer({
      id: 'xfer-1',
      sender_invocation_id: 'inv-src',
      sender_group_folder: 'spec-src',
      message: 'files attached',
      file_count: 1,
      sent_at: '2024-01-01T00:00:00.000Z',
      status: 'pending',
      recipient_task_id: 'task-parent',
      recipient_group_folder: null,
    });
    createTransferFile({
      id: 'tf-1',
      transfer_id: 'xfer-1',
      original_name: 'report.md',
      host_path: srcFile,
      status: 'owned',
    });

    // Create the ipc-in dir (normally done by buildVolumeMounts)
    const ipcInDir = path.join(tmpDir, 'invocations', 'inv-dest', 'ipc-in');
    fs.mkdirSync(ipcInDir, { recursive: true });

    placeFilesForInvocation('task-parent', 'inv-dest', tmpDir);

    // File placed at ipc-in/{transferId}/{name}
    const placedPath = path.join(ipcInDir, 'xfer-1', 'report.md');
    expect(fs.existsSync(placedPath)).toBe(true);
    expect(fs.readFileSync(placedPath, 'utf-8')).toBe('# Report');

    // DB records updated
    expect(getTransferFilesByTransfer('xfer-1')[0].status).toBe('placed');
    expect(getContainerTransfer('xfer-1')!.status).toBe('in_transit');
  });

  it('is a no-op when there are no owned transfers for the task', () => {
    placeFilesForInvocation('task-nobody', 'inv-x', tmpDir);
    // No error thrown
  });
});
