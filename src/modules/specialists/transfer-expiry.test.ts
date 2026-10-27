/**
 * A transfer whose files never reached its recipient task expires when that
 * task ends (specs/specialists.allium TransferExpiredOnRequesterTerminal /
 * ...Failed, which include pending). Example from the 2026-10-27 weed: a
 * grandchild delivers to its parent C, the transfer is pending with C's wake
 * queued, then C's own parent times out waiting and cancels C. The transfer
 * stayed pending for good and its staging copy was never reclaimed — the
 * expiry query skipped pending, and routeResult only expired anything when it
 * had routed the result, which it does not for a parent no longer waiting.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-transfer-expiry';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-transfer-expiry' };
});
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
}));
vi.mock('../../session-manager.js', () => ({
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(async () => {}),
  withExistingMailboxSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import { createSpecialist, createTask, getTask } from './db.js';
import { expireTransfersForTerminalTask, TRANSFERS_BASE_DIR } from './invocation.js';
import { routeResult } from './routing.js';
import type { SpecialistTask } from './types.js';

const now = () => new Date().toISOString();

function task(id: string, status: SpecialistTask['status'], requesterTask: string | null): SpecialistTask {
  return {
    id,
    specialist_group_id: 'ag-spec',
    prompt: 'p',
    requester_group_id: requesterTask ? null : 'ag-main',
    requester_task_id: requesterTask,
    requester_session_id: 'sess-main',
    depth: requesterTask ? 1 : 0,
    chain_delegation_count: 0,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status,
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };
}

/** gp (running, not waiting) -> c (the task that ends) -> g (delivered to c, transfer pending). */
async function chain(cStatus: SpecialistTask['status']): Promise<void> {
  for (const id of ['ag-main', 'ag-spec']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  await createSpecialist({
    agent_group_id: 'ag-spec',
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
  for (const [id, group, thread] of [
    ['sess-main', 'ag-main', null],
    ['sess-c', 'ag-spec', 'task-c'],
    ['sess-g', 'ag-spec', 'task-g'],
  ] as const) {
    await createSession({
      id,
      agent_group_id: group,
      messaging_group_id: null,
      thread_id: thread,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      processing_state: 'idle',
      last_active: now(),
      created_at: now(),
    });
  }
  await createTask(task('task-gp', 'running', null));
  await createTask(task('task-c', cStatus, 'task-gp'));
  await createTask(task('task-g', 'completed', 'task-c'));
  const db = getDb();
  await db.run(
    `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at, ended_at)
     VALUES ('inv-g', 'sess-g', 'task-g', '/x/out', '/x/in', ?, ?)`,
    now(),
    now(),
  );
  await db.run(
    `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
     VALUES ('xfer-g', 'task-g', 'inv-g', 'findings', 0, 1, ?, 'pending', 'sess-c')`,
    now(),
  );
  await db.run(
    `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
     VALUES ('tf-g', 'xfer-g', 'report.md', '/x/report.md', 'owned', NULL)`,
  );
  fs.mkdirSync(path.join(TRANSFERS_BASE_DIR, 'xfer-g'), { recursive: true });
}

async function transferState(): Promise<{ transfer: string; file: string; staged: boolean }> {
  const db = getDb();
  const t = (await db.get("SELECT status FROM container_transfers WHERE id = 'xfer-g'")) as { status: string };
  const f = (await db.get("SELECT status FROM transfer_files WHERE id = 'tf-g'")) as { status: string };
  return { transfer: t.status, file: f.status, staged: fs.existsSync(path.join(TRANSFERS_BASE_DIR, 'xfer-g')) };
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a pending transfer to a task that ends', () => {
  it('expires, and its staging copy is reclaimed', async () => {
    await chain('failed');

    await expireTransfersForTerminalTask('task-c');

    expect(await transferState()).toEqual({ transfer: 'expired', file: 'expired', staged: false });
  });

  it('expires even when the ended task has no one waiting to route its result to', async () => {
    await chain('failed'); // task-gp is running, not awaiting task-c

    await routeResult((await getTask('task-c'))!);

    expect(await transferState()).toEqual({ transfer: 'expired', file: 'expired', staged: false });
  });
});
