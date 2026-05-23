// Tests for routeResult — specialist session cleanup on task terminal state.
//
// Covers the fix for the "session never closed" bug: when routeResult is
// called for a terminal task, the specialist session must be marked closed
// and its pending inbound messages must be marked failed, so the host sweep
// stops treating the session as live.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createSpecialist, createTask } from './db.js';
import { routeResult } from './routing.js';
import type { SpecialistTask } from './types.js';

vi.mock('../../container-runner.js', () => ({
  wakeOrQueue: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
  // Return a path that doesn't exist on disk — closeSpecialistSession's
  // existsSync guard skips the inbound.db cleanup, which is fine here.
  inboundDbPath: vi.fn().mockReturnValue('/nonexistent/test/inbound.db'),
  openInboundDb: vi.fn(),
}));

vi.mock('./invocation.js', () => ({
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

let seq = 0;
function uid(prefix: string) {
  return `${prefix}-${++seq}`;
}

interface TaskSetup {
  specialistGroupId: string;
  specialistSessionId: string;
  requesterGroupId: string;
  requesterSessionId: string;
  task: SpecialistTask;
}

function makeFailedRootTask(): TaskSetup {
  const specialistGroupId = uid('ag-spec');
  const specialistSessionId = uid('sess-spec');
  const requesterGroupId = uid('ag-main');
  const requesterSessionId = uid('sess-main');
  const taskId = uid('task');

  createAgentGroup({
    id: specialistGroupId,
    name: 'Specialist',
    folder: specialistGroupId,
    agent_provider: null,
    created_at: now(),
  });
  createSpecialist({
    agent_group_id: specialistGroupId,
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
  createAgentGroup({
    id: requesterGroupId,
    name: 'Main',
    folder: requesterGroupId,
    agent_provider: null,
    created_at: now(),
  });

  // Specialist session — thread_id = task id, as createSpecialistSession sets it.
  createSession({
    id: specialistSessionId,
    agent_group_id: specialistGroupId,
    messaging_group_id: null,
    thread_id: taskId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });

  // Requester session (main group) — routeResult delivers the result here.
  createSession({
    id: requesterSessionId,
    agent_group_id: requesterGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });

  const task: SpecialistTask = {
    id: taskId,
    specialist_group_id: specialistGroupId,
    prompt: 'do work',
    requester_group_id: requesterGroupId,
    requester_task_id: null,
    requester_session_id: requesterSessionId,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'failed',
    dispatched_at: now(),
    restart_attempt_count: 3,
    closed_at: now(),
    result: null,
    failure_kind: 'host_restart',
    failure_detail: 'container failed to start after 2 restart attempts',
    pending_sub_task_id: null,
    committed_files: null,
  };
  createTask(task);

  return { specialistGroupId, specialistSessionId, requesterGroupId, requesterSessionId, task };
}

// ── test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seq = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  closeDb();
});

// ── session cleanup on terminal state ────────────────────────────────────────

describe('specialist session cleanup on terminal task', () => {
  it('marks the specialist session closed when a failed task is routed', async () => {
    const { specialistSessionId, task } = makeFailedRootTask();

    expect(getSession(specialistSessionId)?.status).toBe('active');
    await routeResult(task);
    expect(getSession(specialistSessionId)?.status).toBe('closed');
  });

  it('marks the specialist session closed when a completed task is routed', async () => {
    const setup = makeFailedRootTask();
    const completedTask: SpecialistTask = {
      ...setup.task,
      status: 'completed',
      result: 'done',
      failure_kind: null,
      failure_detail: null,
    };

    await routeResult(completedTask);

    expect(getSession(setup.specialistSessionId)?.status).toBe('closed');
  });

  it('leaves the requester session active after routing', async () => {
    // The requester (main group) session must stay active — it's still live
    // and will receive the result message.
    const { requesterSessionId, task } = makeFailedRootTask();

    await routeResult(task);

    expect(getSession(requesterSessionId)?.status).toBe('active');
  });

  it('does not throw when the specialist session has no inbound.db on disk', async () => {
    // existsSync returns false for the mocked path — closeSpecialistSession
    // must handle this gracefully without crashing.
    const { task } = makeFailedRootTask();
    await expect(routeResult(task)).resolves.not.toThrow();
  });
});
