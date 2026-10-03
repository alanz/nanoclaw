/**
 * Only files inside the delivering invocation's ipc-out may leave a
 * specialist container. The host copies with its own privileges, so before
 * this a path like `/workspace/ipc-out/../../…` or a symlink placed in ipc-out
 * copied any file the host could read into the requester's workspace (P4).
 * Live, a Researcher also listed a file from /workspace/ipc-in; the loose
 * mapping turned it into a missing ipc-out file and it vanished silently.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ root: '' }));

vi.mock('./db.js', () => ({
  getLiveTaskForSession: vi.fn(async () => ({
    id: 'task-1',
    status: 'running',
    requester_group_id: 'ag-main',
  })),
  updateTaskStatus: vi.fn(async () => {}),
}));
vi.mock('./routing.js', () => ({ routeResult: vi.fn(async () => {}) }));
vi.mock('./invocation.js', () => ({
  getActiveInvocation: vi.fn(async () => ({ id: 'inv-1', ipc_out_host_path: path.join(env.root, 'out') })),
  hostStagingPath: (transferId: string, name: string) => path.join(env.root, 'staging', transferId, name),
  get TRANSFERS_BASE_DIR() {
    return path.join(env.root, 'staging');
  },
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ hasTable: async () => true, run: async () => {} }),
}));

import type { Session } from '../../types.js';
import { handleDeliverSpecialistResult, resolveIpcOutFile } from './delivery.js';
import { routeResult } from './routing.js';

let out: string;
let secret: string;

beforeEach(() => {
  env.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-out-')));
  out = path.join(env.root, 'out');
  fs.mkdirSync(path.join(out, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(out, 'report.md'), 'the report');
  fs.writeFileSync(path.join(out, 'sub', 'data.csv'), 'a,b');
  secret = path.join(env.root, 'host-secret.txt');
  fs.writeFileSync(secret, 'SECRET');
  vi.mocked(routeResult).mockClear();
});

afterEach(() => {
  fs.rmSync(env.root, { recursive: true, force: true });
});

describe('resolveIpcOutFile', () => {
  it('accepts files in ipc-out, absolute or relative to it', () => {
    expect(resolveIpcOutFile(out, '/workspace/ipc-out/report.md')).toEqual({ hostPath: path.join(out, 'report.md') });
    expect(resolveIpcOutFile(out, 'sub/data.csv')).toEqual({ hostPath: path.join(out, 'sub', 'data.csv') });
  });

  it.each([
    ['/workspace/ipc-in/xfer-1/report.md', 'a received file (the live case)'],
    ['/workspace/ipc-out/../../host-secret.txt', 'dot-dot out of ipc-out'],
    ['../host-secret.txt', 'relative dot-dot'],
    ['/workspace/ipc-outX/report.md', 'a look-alike prefix'],
    ['/etc/passwd', 'an absolute path elsewhere'],
    ['/workspace/ipc-out/', 'ipc-out itself'],
  ])('refuses %s (%s)', (p) => {
    expect(resolveIpcOutFile(out, p)).toHaveProperty('error');
  });

  it('refuses a symlink in ipc-out pointing at a host file', () => {
    fs.symlinkSync(secret, path.join(out, 'innocent.md'));
    expect(resolveIpcOutFile(out, '/workspace/ipc-out/innocent.md')).toEqual({
      error: 'is or passes through a symbolic link',
    });
  });

  it('refuses a file reached through a symlinked directory', () => {
    fs.symlinkSync(env.root, path.join(out, 'up'));
    expect(resolveIpcOutFile(out, '/workspace/ipc-out/up/host-secret.txt')).toEqual({
      error: 'is or passes through a symbolic link',
    });
  });

  it('refuses a directory and a missing file', () => {
    expect(resolveIpcOutFile(out, '/workspace/ipc-out/sub')).toEqual({ error: 'not a regular file' });
    expect(resolveIpcOutFile(out, '/workspace/ipc-out/nope.md')).toEqual({ error: 'no such file' });
  });
});

describe('deliver_specialist_result file handover', () => {
  const session = { id: 'sess-1', agent_group_id: 'ag-spec' } as Session;

  it('stages only ipc-out files, never a linked host file, and tells the requester what it refused', async () => {
    fs.symlinkSync(secret, path.join(out, 'innocent.md'));

    await handleDeliverSpecialistResult(
      {
        result_text: 'Done. See /workspace/ipc-out/report.md',
        file_paths: [
          '/workspace/ipc-out/report.md',
          '/workspace/ipc-out/innocent.md',
          '/workspace/ipc-out/../../host-secret.txt',
          '/workspace/ipc-in/xfer-1/report.md',
        ],
      },
      session,
    );

    const staged = fs
      .readdirSync(path.join(env.root, 'staging'))
      .flatMap((dir) =>
        fs
          .readdirSync(path.join(env.root, 'staging', dir))
          .map((f) => fs.readFileSync(path.join(env.root, 'staging', dir, f), 'utf-8')),
      );
    expect(staged).toEqual(['the report']);

    const [, transfer] = vi.mocked(routeResult).mock.calls[0];
    expect(transfer!.file_count).toBe(1);
    expect(transfer!.result_text).toContain('[Not delivered:');
    expect(transfer!.result_text).toContain('/workspace/ipc-out/innocent.md (is or passes through a symbolic link)');
    expect(transfer!.result_text).toContain('/workspace/ipc-in/xfer-1/report.md (not in /workspace/ipc-out');
  });

  it('notes refusals in the result even when no file comes through', async () => {
    await handleDeliverSpecialistResult(
      { result_text: 'Done.', file_paths: ['/workspace/ipc-in/xfer-1/report.md'] },
      session,
    );

    const [completed, transfer] = vi.mocked(routeResult).mock.calls[0];
    expect(transfer).toBeNull();
    expect(completed.result).toContain('[Not delivered: /workspace/ipc-in/xfer-1/report.md');
  });
});
