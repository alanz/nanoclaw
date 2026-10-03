/**
 * A root task's files delivered with commit_to_memory go straight into the
 * requester group's memory/reports/. specialists.allium makes that one
 * operation: record each file's memory_path, the task's committed_files, and
 * take the transfer pending → committed → expired. The code marked the files
 * `placed` (they were never placed into any ipc-in) and wrote committed and
 * expired as two separate steps (P11).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-routing-commit';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-routing-commit/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-routing-commit/groups',
  };
});
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
  withExistingMailboxSession: vi.fn().mockResolvedValue(undefined),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import { createSpecialist, createTask, getTask } from './db.js';
import { routeResult } from './routing.js';
import type { ContainerTransfer, SpecialistTask } from './types.js';

const now = () => new Date().toISOString();
const STAGING = path.join(ROOT, 'staging');

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function rootTaskWithCommittedTransfer(): Promise<{ task: SpecialistTask; transfer: ContainerTransfer }> {
  await createAgentGroup({ id: 'ag-main', name: 'Main', folder: 'main', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-spec', name: 'Spec', folder: 'spec', agent_provider: null, created_at: now() });
  await createSpecialist({
    agent_group_id: 'ag-spec',
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
  const base = {
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    processing_state: 'idle' as const,
    last_active: now(),
    created_at: now(),
  };
  await createSession({
    ...base,
    id: 'sess-main',
    agent_group_id: 'ag-main',
    messaging_group_id: null,
    thread_id: null,
  });
  await createSession({
    ...base,
    id: 'sess-spec',
    agent_group_id: 'ag-spec',
    messaging_group_id: null,
    thread_id: 'task-1',
  });
  const task: SpecialistTask = {
    id: 'task-1',
    specialist_group_id: 'ag-spec',
    prompt: 'p',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 0,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'completed',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: now(),
    result: 'done',
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };
  await createTask(task);

  const db = getDb();
  await db.run(
    `INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at, ended_at)
     VALUES ('inv-1', 'sess-spec', 'task-1', '/x/out', '/x/in', ?, ?)`,
    now(),
    now(),
  );
  const transfer: ContainerTransfer = {
    id: 'xfer-1',
    task_id: 'task-1',
    sender_invocation_id: 'inv-1',
    result_text: 'See memory/reports/report.md',
    commit_to_memory: 1,
    file_count: 2,
    sent_at: now(),
    status: 'pending',
    recipient_session_id: null,
  };
  await db.run(
    `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
     VALUES (@id, @task_id, @sender_invocation_id, @result_text, @commit_to_memory, @file_count, @sent_at, @status, @recipient_session_id)`,
    transfer,
  );
  // One file whose staging copy exists, one whose copy has gone missing.
  fs.writeFileSync(path.join(STAGING, 'report.md'), 'the report');
  for (const [id, name] of [
    ['tf-ok', 'report.md'],
    ['tf-missing', 'gone.md'],
  ]) {
    await db.run(
      `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
       VALUES (?, 'xfer-1', ?, ?, 'owned', NULL)`,
      id,
      name,
      path.join(STAGING, name),
    );
  }
  return { task, transfer };
}

describe('committing a root task’s files to memory', () => {
  it('records each file once and expires the transfer, with no file marked placed', async () => {
    const { task, transfer } = await rootTaskWithCommittedTransfer();

    await routeResult(task, transfer);

    const db = getDb();
    expect(
      ((await db.get("SELECT status FROM container_transfers WHERE id = 'xfer-1'")) as { status: string }).status,
    ).toBe('expired');
    const files = (await db.all('SELECT id, status, memory_path FROM transfer_files ORDER BY id')) as Array<{
      id: string;
      status: string;
      memory_path: string | null;
    }>;
    expect(files).toEqual([
      { id: 'tf-missing', status: 'expired', memory_path: null },
      { id: 'tf-ok', status: 'expired', memory_path: 'memory/reports/report.md' },
    ]);
    expect(JSON.parse((await getTask('task-1'))!.committed_files!)).toEqual(['memory/reports/report.md']);
    expect(fs.readFileSync(path.join(ROOT, 'groups', 'main', 'memory', 'reports', 'report.md'), 'utf-8')).toBe(
      'the report',
    );
  });
});
