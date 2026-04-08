import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createContainerTransfer,
  createTransferFile,
  getContainerTransfer,
  getTransferFilesByTransfer,
} from './db.js';
import { buildRejectionError, expireTransfersForTask } from './ipc-transfer.js';

beforeEach(() => {
  _initTestDatabase();
});

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
