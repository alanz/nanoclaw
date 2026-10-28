/**
 * Memory read access for specialist sessions (specs/memory.allium
 * memory_group_for): a memory-provider specialist reads the index of the main
 * group its task chain serves, through its read-only mount of that group's
 * folder; every other specialist reads none; an ordinary session reads its own.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./invocation.js', () => ({
  buildInvocationForSession: vi.fn().mockResolvedValue(null),
  endInvocationById: vi.fn(),
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
  hostStagingPath: vi.fn(),
  reclaimTransferStaging: vi.fn(),
  sweepInvocationDirs: vi.fn(),
  sweepTransferStaging: vi.fn(),
}));

import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import { memoryAccessFor } from '../../memory/manager.js';
import { createSpecialist, createTask } from './db.js';
import type { SpecialistTask } from './types.js';
import './index.js';

const now = () => new Date().toISOString();

async function group(id: string, kind: 'plain' | 'specialist' | 'memory', mounts: unknown[] = []): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  await getDb().run(
    `INSERT INTO container_configs (agent_group_id, skills, mcp_servers, packages_apt, packages_npm, additional_mounts, updated_at)
     VALUES (?, '[]', '{}', '[]', '[]', ?, ?)`,
    id,
    JSON.stringify(mounts),
    now(),
  );
  if (kind === 'plain') return;
  await createSpecialist({
    agent_group_id: id,
    is_memory_provider: kind === 'memory' ? 1 : 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
}

async function session(id: string, groupId: string, threadId: string | null): Promise<void> {
  await createSession({
    id,
    agent_group_id: groupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  } as never);
}

function taskRow(fields: Partial<SpecialistTask> & { id: string; specialist_group_id: string }): SpecialistTask {
  return {
    prompt: 'p',
    requester_group_id: null,
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
    ...fields,
  };
}

beforeAll(async () => {
  await runMigrations(await initTestDb());
  // Every fixture before the first lookup: the specialist list loads once.
  await group('ag-main', 'plain');
  await group('ag-coder', 'specialist');
  await group('ag-mem', 'memory', [
    { hostPath: path.join(GROUPS_DIR, 'ag-main'), containerPath: 'main', readonly: true },
  ]);
  await group('ag-mem-nomount', 'memory');
  await session('sess-main', 'ag-main', null);
  await createTask(taskRow({ id: 'task-coder', specialist_group_id: 'ag-coder', requester_group_id: 'ag-main' }));
  await session('sess-coder', 'ag-coder', 'task-coder');
  await createTask(
    taskRow({
      id: 'task-mem',
      specialist_group_id: 'ag-mem',
      requester_task_id: 'task-coder',
      requester_session_id: 'sess-coder',
      depth: 1,
    }),
  );
  await session('sess-mem', 'ag-mem', 'task-mem');
  await createTask(
    taskRow({ id: 'task-nomount', specialist_group_id: 'ag-mem-nomount', requester_group_id: 'ag-main' }),
  );
  await session('sess-nomount', 'ag-mem-nomount', 'task-nomount');
});
afterAll(async () => {
  await closeDb();
});

describe('memory access by session', () => {
  it('an ordinary session reads its own group, in its own workspace', async () => {
    expect(await memoryAccessFor({ id: 'sess-main', agent_group_id: 'ag-main', thread_id: null })).toEqual({
      groupId: 'ag-main',
      workspacePath: '/workspace/agent',
    });
  });

  it('a memory provider reads the main group its chain serves, through its mount of that folder', async () => {
    expect(await memoryAccessFor({ id: 'sess-mem', agent_group_id: 'ag-mem', thread_id: 'task-mem' })).toEqual({
      groupId: 'ag-main',
      workspacePath: '/workspace/extra/main',
    });
  });

  it('any other specialist reads none', async () => {
    expect(await memoryAccessFor({ id: 'sess-coder', agent_group_id: 'ag-coder', thread_id: 'task-coder' })).toBeNull();
  });

  it('a memory provider with no mount of that group reads none', async () => {
    expect(
      await memoryAccessFor({ id: 'sess-nomount', agent_group_id: 'ag-mem-nomount', thread_id: 'task-nomount' }),
    ).toBeNull();
  });
});
