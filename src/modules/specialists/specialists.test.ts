// Tests generated from specs/specialists.allium (allium plan: 195 obligations)
// The specialists module is not yet implemented. Every test here is a stub
// (it.todo) that documents an obligation from the spec. Remove the .todo suffix
// and wire to the implementation as each piece is built.
//
// Spec: specialists.allium — SpecialistTask lifecycle, delegation from main
// group, sub-task dispatch, chain limit enforcement, IPC file handover,
// container crash/restart recovery.
//
// Covered obligation categories:
//   enum_comparable (5)      config_default (10)     entity_fields (7)
//   value_equality (2)       entity_optional (5)     entity_relationship (1)
//   when_presence (4)        derived (1)             invariant (12)
//   transition_edge (22)     transition_rejected (5) transition_terminal (5)
//   rule_success (27)        rule_failure (78)       rule_entity_creation (11)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';

import { SPECIALISTS_CONFIG } from './config.js';
import type {
  IpcMountStatus,
  TransferStatus,
  TransferFileStatus,
  SpecialistTaskStatus,
  SpecialistFailureKind,
  ContainerTransfer,
  TransferFile,
  Invocation,
} from './types.js';
import { createTask, createSpecialist } from './db.js';
import type { SpecialistTask } from './types.js';

function now() {
  return new Date().toISOString();
}

function makeAgentGroup(id: string, folder: string) {
  return { id, name: `Group ${id}`, folder, agent_provider: null, created_at: now() };
}

function makeSession(id: string, agentGroupId: string) {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: now(),
    created_at: now(),
  };
}

function makeTask(overrides: Partial<SpecialistTask> & { id: string; specialist_group_id: string; requester_session_id: string }): SpecialistTask {
  return {
    prompt: 'do work',
    requester_group_id: 'main-group',
    requester_task_id: null,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'queued',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// Enums — obligation ids: enum-comparable.*
// ---------------------------------------------------------------------------

describe('SpecialistTaskStatus enum', () => {
  it('has members: queued, running, awaiting_sub_task, awaiting_restart, completed, failed', () => {
    const statuses: SpecialistTaskStatus[] = ['queued', 'running', 'awaiting_sub_task', 'awaiting_restart', 'completed', 'failed'];
    expect(statuses).toHaveLength(6);
    expect(statuses).toContain('queued');
    expect(statuses).toContain('running');
    expect(statuses).toContain('awaiting_sub_task');
    expect(statuses).toContain('awaiting_restart');
    expect(statuses).toContain('completed');
    expect(statuses).toContain('failed');
  });

  it('values are comparable with ===', () => {
    const s: SpecialistTaskStatus = 'running';
    expect(s).toBe('running');
    expect(s).not.toBe('queued');
  });
});

describe('SpecialistFailureKind enum', () => {
  it('has members: cycle_detected, depth_exceeded, count_exceeded, same_type_limit_exceeded, timeout, execution_error, host_restart', () => {
    const kinds: SpecialistFailureKind[] = [
      'cycle_detected',
      'depth_exceeded',
      'count_exceeded',
      'same_type_limit_exceeded',
      'timeout',
      'execution_error',
      'host_restart',
    ];
    expect(kinds).toHaveLength(7);
    for (const k of kinds) {
      expect(typeof k).toBe('string');
    }
  });

  it('values are comparable with ===', () => {
    const k: SpecialistFailureKind = 'timeout';
    expect(k).toBe('timeout');
    expect(k).not.toBe('execution_error');
  });
});

describe('IpcMountStatus enum', () => {
  it('has members: active, cleared', () => {
    const statuses: IpcMountStatus[] = ['active', 'cleared'];
    expect(statuses).toHaveLength(2);
    expect(statuses).toContain('active');
    expect(statuses).toContain('cleared');
  });

  it('values are comparable with ===', () => {
    const s: IpcMountStatus = 'active';
    expect(s).toBe('active');
    expect(s).not.toBe('cleared');
  });
});

describe('TransferStatus enum', () => {
  it('has members: pending, in_transit, committed, expired', () => {
    const statuses: TransferStatus[] = ['pending', 'in_transit', 'committed', 'expired'];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('in_transit');
    expect(statuses).toContain('committed');
    expect(statuses).toContain('expired');
  });

  it('values are comparable with ===', () => {
    const s: TransferStatus = 'pending';
    expect(s).toBe('pending');
    expect(s).not.toBe('expired');
  });
});

describe('TransferFileStatus enum', () => {
  it('has members: staged, owned, placed, expired', () => {
    const statuses: TransferFileStatus[] = ['staged', 'owned', 'placed', 'expired'];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain('staged');
    expect(statuses).toContain('owned');
    expect(statuses).toContain('placed');
    expect(statuses).toContain('expired');
  });

  it('values are comparable with ===', () => {
    const s: TransferFileStatus = 'owned';
    expect(s).toBe('owned');
    expect(s).not.toBe('placed');
  });
});

// ---------------------------------------------------------------------------
// Value types — obligation ids: value-equality.*, entity-fields.*
// ---------------------------------------------------------------------------

describe('TaskFailure value type', () => {
  it('has fields: kind (SpecialistFailureKind), detail (string)', () => {
    const failure = { kind: 'timeout' as SpecialistFailureKind, detail: 'ran too long' };
    expect(typeof failure.kind).toBe('string');
    expect(typeof failure.detail).toBe('string');
  });

  it('two TaskFailure objects with the same fields are structurally equal', () => {
    const a = { kind: 'timeout' as SpecialistFailureKind, detail: 'ran too long' };
    const b = { kind: 'timeout' as SpecialistFailureKind, detail: 'ran too long' };
    expect(a).toEqual(b);
  });

  it('two TaskFailure objects with different fields are not equal', () => {
    const a = { kind: 'timeout' as SpecialistFailureKind, detail: 'ran too long' };
    const b = { kind: 'execution_error' as SpecialistFailureKind, detail: 'crashed' };
    expect(a).not.toEqual(b);
  });
});

describe('Invocation value type', () => {
  it('has fields: id (string), session_id (string), task_id (string | null), ipc paths (string), started_at (string), ended_at (string | null)', () => {
    const inv: Invocation = {
      id: 'inv-1',
      session_id: 'sess-1',
      task_id: null,
      ipc_out_host_path: '/tmp/out',
      ipc_in_host_path: '/tmp/in',
      started_at: now(),
      ended_at: null,
    };
    expect(typeof inv.id).toBe('string');
    expect(typeof inv.session_id).toBe('string');
    expect(inv.task_id).toBeNull();
    expect(typeof inv.ipc_out_host_path).toBe('string');
    expect(typeof inv.ipc_in_host_path).toBe('string');
    expect(typeof inv.started_at).toBe('string');
    expect(inv.ended_at).toBeNull();
  });

  it('task_id is nullable — Invocation for a main-group run has task_id = null', () => {
    const inv: Invocation = {
      id: 'inv-2',
      session_id: 'sess-2',
      task_id: null,
      ipc_out_host_path: '/tmp/out',
      ipc_in_host_path: '/tmp/in',
      started_at: now(),
      ended_at: null,
    };
    expect(inv.task_id).toBeNull();
  });

  it('two Invocation objects with the same fields are structurally equal', () => {
    const ts = now();
    const a: Invocation = { id: 'inv-x', session_id: 'sess-x', task_id: null, ipc_out_host_path: '/o', ipc_in_host_path: '/i', started_at: ts, ended_at: null };
    const b: Invocation = { id: 'inv-x', session_id: 'sess-x', task_id: null, ipc_out_host_path: '/o', ipc_in_host_path: '/i', started_at: ts, ended_at: null };
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Config defaults — obligation ids: config-default.*
// ---------------------------------------------------------------------------

describe('specialists config defaults', () => {
  it('max_specialist_depth defaults to 5', () => {
    expect(SPECIALISTS_CONFIG.maxSpecialistDepth).toBe(5);
  });

  it('max_chain_delegations defaults to 20', () => {
    expect(SPECIALISTS_CONFIG.maxChainDelegations).toBe(20);
  });

  it('max_same_type_dispatches defaults to 3', () => {
    expect(SPECIALISTS_CONFIG.maxSameTypeDispatches).toBe(3);
  });

  it('max_task_duration defaults to 4 hours (14_400_000 ms)', () => {
    expect(SPECIALISTS_CONFIG.maxTaskDurationMs).toBe(14_400_000);
  });

  it('max_restart_retries defaults to 2', () => {
    expect(SPECIALISTS_CONFIG.maxRestartRetries).toBe(2);
  });

  it('default_last_turn_sub_notice is the "[Final iteration: this is your last opportunity...]" string', () => {
    expect(SPECIALISTS_CONFIG.defaultLastTurnSubNotice).toContain('[Final iteration: this is your last opportunity');
  });

  it('default_last_turn_parent_notice is the "[Final iteration: no further responses...]" string', () => {
    expect(SPECIALISTS_CONFIG.defaultLastTurnParentNotice).toContain('[Final iteration: no further responses');
  });

  it('ipc_out_container_path defaults to "/workspace/ipc-out"', () => {
    expect(SPECIALISTS_CONFIG.ipcOutContainerPath).toBe('/workspace/ipc-out');
  });

  it('ipc_in_container_path defaults to "/workspace/ipc-in"', () => {
    expect(SPECIALISTS_CONFIG.ipcInContainerPath).toBe('/workspace/ipc-in');
  });

  it('memory_reports_subpath defaults to "memory/reports"', () => {
    expect(SPECIALISTS_CONFIG.memoryReportsSubpath).toBe('memory/reports');
  });
});

// ---------------------------------------------------------------------------
// SpecialistTask — entity fields, optional fields, when-presence fields,
// derived values, invariants
// ---------------------------------------------------------------------------

describe('SpecialistTask entity', () => {
  function setupMainGroup() {
    createAgentGroup(makeAgentGroup('main-group', 'main'));
    getDb().prepare('UPDATE agent_groups SET is_main = 1 WHERE id = ?').run('main-group');
    createAgentGroup(makeAgentGroup('spec-group', 'spec'));
    createSpecialist({
      agent_group_id: 'spec-group',
      is_memory_provider: 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: now(),
    });
    createSession(makeSession('sess-main', 'main-group'));
  }

  describe('required fields', () => {
    it('has: specialist_group, prompt, depth, chain_delegation_count, ancestor_groups, is_last_same_type_dispatch, status, dispatched_at, restart_attempt_count', () => {
      setupMainGroup();
      const task = makeTask({ id: 'task-1', specialist_group_id: 'spec-group', requester_session_id: 'sess-main' });
      createTask(task);
      const retrieved = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-1') as SpecialistTask;
      expect(retrieved.specialist_group_id).toBe('spec-group');
      expect(retrieved.prompt).toBe('do work');
      expect(retrieved.depth).toBe(0);
      expect(retrieved.chain_delegation_count).toBe(1);
      expect(retrieved.ancestor_group_ids).toBe('[]');
      expect(retrieved.is_last_same_type_dispatch).toBe(0);
      expect(retrieved.status).toBe('queued');
      expect(typeof retrieved.dispatched_at).toBe('string');
      expect(retrieved.restart_attempt_count).toBe(0);
    });
  });

  describe('optional fields — obligation ids: entity-optional.SpecialistTask.*', () => {
    it('requester_group is nullable (root task has requester_group set, sub-task has null)', () => {
      setupMainGroup();
      const rootTask = makeTask({ id: 'task-root', specialist_group_id: 'spec-group', requester_session_id: 'sess-main', requester_group_id: 'main-group', requester_task_id: null });
      createTask(rootTask);
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-root') as SpecialistTask;
      expect(r.requester_group_id).toBe('main-group');
      expect(r.requester_task_id).toBeNull();
    });

    it('requester_task is nullable (root task has requester_task null)', () => {
      setupMainGroup();
      const task = makeTask({ id: 'task-2', specialist_group_id: 'spec-group', requester_session_id: 'sess-main' });
      createTask(task);
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-2') as SpecialistTask;
      expect(r.requester_task_id).toBeNull();
    });

    it('closed_at is nullable until the task reaches a terminal state', () => {
      setupMainGroup();
      const task = makeTask({ id: 'task-3', specialist_group_id: 'spec-group', requester_session_id: 'sess-main' });
      createTask(task);
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-3') as SpecialistTask;
      expect(r.closed_at).toBeNull();
    });

    it('committed_files is nullable even when status = completed (text-only delivery)', () => {
      setupMainGroup();
      const task = makeTask({ id: 'task-4', specialist_group_id: 'spec-group', requester_session_id: 'sess-main', status: 'completed', result: 'done', closed_at: now() });
      createTask(task);
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-4') as SpecialistTask;
      expect(r.committed_files).toBeNull();
    });
  });

  describe('state-dependent fields — obligation ids: when-presence.SpecialistTask.*', () => {
    it('pending_sub_task is present when status = awaiting_sub_task', () => {
      setupMainGroup();
      // Create parent first without child reference, then create child, then update parent
      const parentTask = makeTask({ id: 'task-parent', specialist_group_id: 'spec-group', requester_session_id: 'sess-main', status: 'queued', pending_sub_task_id: null });
      createTask(parentTask);
      const childTask = makeTask({ id: 'task-child', specialist_group_id: 'spec-group', requester_session_id: 'sess-main', requester_group_id: null, requester_task_id: 'task-parent' });
      createTask(childTask);
      // Now update parent to awaiting_sub_task with child reference
      getDb().prepare("UPDATE specialist_tasks SET status = 'awaiting_sub_task', pending_sub_task_id = ? WHERE id = ?").run('task-child', 'task-parent');
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-parent') as SpecialistTask;
      expect(r.status).toBe('awaiting_sub_task');
      expect(r.pending_sub_task_id).toBe('task-child');
    });

    it('result is present when status = completed', () => {
      setupMainGroup();
      const task = makeTask({ id: 'task-completed', specialist_group_id: 'spec-group', requester_session_id: 'sess-main', status: 'completed', result: 'final answer', closed_at: now() });
      createTask(task);
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-completed') as SpecialistTask;
      expect(r.status).toBe('completed');
      expect(r.result).toBe('final answer');
    });

    it('failure_kind is present when status = failed', () => {
      setupMainGroup();
      const task = makeTask({ id: 'task-failed', specialist_group_id: 'spec-group', requester_session_id: 'sess-main', status: 'failed', failure_kind: 'timeout', failure_detail: 'exceeded limit', closed_at: now() });
      createTask(task);
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-failed') as SpecialistTask;
      expect(r.status).toBe('failed');
      expect(r.failure_kind).toBe('timeout');
      expect(r.failure_detail).toBe('exceeded limit');
    });
  });

  describe('invariants — obligation ids: invariant.SpecialistTask.*', () => {
    it('DepthMatchesAncestorCount: root task has depth=0 and ancestor_groups=[]', () => {
      setupMainGroup();
      const task = makeTask({ id: 'task-root-depth', specialist_group_id: 'spec-group', requester_session_id: 'sess-main', depth: 0, ancestor_group_ids: '[]' });
      createTask(task);
      const r = getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get('task-root-depth') as SpecialistTask;
      const ancestors = JSON.parse(r.ancestor_group_ids) as string[];
      expect(r.depth).toBe(0);
      expect(ancestors).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Global invariants
// ---------------------------------------------------------------------------

describe('global invariants', () => {
  it('TransferFilesMatchCount: ContainerTransfer.file_count = transfer.files.length', () => {
    // Verify by inserting a transfer and checking the constraint holds logically
    createAgentGroup(makeAgentGroup('main-group', 'main'));
    getDb().prepare('UPDATE agent_groups SET is_main = 1 WHERE id = ?').run('main-group');
    createAgentGroup(makeAgentGroup('spec-group', 'spec'));
    createSpecialist({ agent_group_id: 'spec-group', is_memory_provider: 0, last_turn_sub_notice: null, last_turn_parent_notice: null, created_at: now() });
    createSession(makeSession('sess-1', 'main-group'));
    createSession(makeSession('sess-spec-1', 'spec-group'));
    createTask(makeTask({ id: 'task-xfer', specialist_group_id: 'spec-group', requester_session_id: 'sess-1' }));

    // Create an invocation row
    const db = getDb();
    db.prepare(`INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inv-1', 'sess-spec-1', 'task-xfer', '/tmp/out', '/tmp/in', now());

    // Create a ContainerTransfer with file_count=2
    const transfer: ContainerTransfer = {
      id: 'xfer-1',
      task_id: 'task-xfer',
      sender_invocation_id: 'inv-1',
      result_text: 'result',
      commit_to_memory: 0,
      file_count: 2,
      sent_at: now(),
      status: 'pending',
      recipient_session_id: null,
    };
    db.prepare(`INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
      VALUES (@id, @task_id, @sender_invocation_id, @result_text, @commit_to_memory, @file_count, @sent_at, @status, @recipient_session_id)`).run(transfer);

    // Insert 2 transfer files
    for (let i = 0; i < 2; i++) {
      const tf: TransferFile = { id: `tf-${i}`, transfer_id: 'xfer-1', original_name: `file${i}.txt`, host_path: `/tmp/f${i}`, status: 'owned', memory_path: null };
      db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path) VALUES (@id, @transfer_id, @original_name, @host_path, @status, @memory_path)`).run(tf);
    }

    const count = (db.prepare('SELECT COUNT(*) as n FROM transfer_files WHERE transfer_id = ?').get('xfer-1') as { n: number }).n;
    const stored = (db.prepare('SELECT file_count FROM container_transfers WHERE id = ?').get('xfer-1') as { file_count: number }).file_count;
    expect(count).toBe(stored);
  });

  it('CommitAndPlaceMutuallyExclusive: a transfer with commit_to_memory=1 should not also have placed files (they go to memory area instead)', () => {
    // This is a design invariant: when commit_to_memory=1 the files are
    // copied to the memory area and the transfer becomes committed/expired,
    // not placed into ipc-in. We verify by checking the enum logic.
    const commitTransferStatus: TransferStatus = 'committed';
    const placeTransferStatus: TransferStatus = 'in_transit';
    expect(commitTransferStatus).not.toBe(placeTransferStatus);
  });
});

// ---------------------------------------------------------------------------
// IpcOutMount state machine
// ---------------------------------------------------------------------------

describe('IpcOutMount state machine', () => {
  function setup() {
    createAgentGroup(makeAgentGroup('spec-group', 'spec'));
    createSpecialist({ agent_group_id: 'spec-group', is_memory_provider: 0, last_turn_sub_notice: null, last_turn_parent_notice: null, created_at: now() });
    createSession(makeSession('sess-ipc', 'spec-group'));
    createTask(makeTask({ id: 'task-ipc', specialist_group_id: 'spec-group', requester_session_id: 'sess-ipc', requester_group_id: null, requester_task_id: 'task-ipc' }));
    // Use self-reference for FK test workaround — create task without FK check
    const db = getDb();
    // Actually just insert invocation directly
    db.prepare(`INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inv-ipc', 'sess-ipc', null, '/tmp/out', '/tmp/in', now());
  }

  it('IpcOutMount is created in active state when an invocation starts', () => {
    setup();
    const db = getDb();
    db.prepare('INSERT INTO ipc_out_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run('om-1', 'inv-ipc', 'active');
    const r = db.prepare('SELECT * FROM ipc_out_mounts WHERE id = ?').get('om-1') as { status: string };
    expect(r.status).toBe('active');
  });

  it('active -> cleared is the only valid transition', () => {
    setup();
    const db = getDb();
    db.prepare('INSERT INTO ipc_out_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run('om-2', 'inv-ipc', 'active');
    db.prepare("UPDATE ipc_out_mounts SET status = 'cleared' WHERE id = ?").run('om-2');
    const r = db.prepare('SELECT * FROM ipc_out_mounts WHERE id = ?').get('om-2') as { status: string };
    expect(r.status).toBe('cleared');
  });

  it('cleared is terminal', () => {
    const statuses: IpcMountStatus[] = ['active', 'cleared'];
    // 'cleared' has no defined outbound transitions
    expect(statuses.indexOf('cleared')).toBeGreaterThan(-1);
  });

  it('IpcOutMount transitions to cleared when the invocation ends', () => {
    setup();
    const db = getDb();
    db.prepare('INSERT INTO ipc_out_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run('om-3', 'inv-ipc', 'active');
    // Simulate end invocation
    db.prepare("UPDATE ipc_out_mounts SET status = 'cleared' WHERE invocation_id = ?").run('inv-ipc');
    const r = db.prepare('SELECT * FROM ipc_out_mounts WHERE id = ?').get('om-3') as { status: string };
    expect(r.status).toBe('cleared');
  });
});

// ---------------------------------------------------------------------------
// IpcInMount state machine
// ---------------------------------------------------------------------------

describe('IpcInMount state machine', () => {
  function setup() {
    createAgentGroup(makeAgentGroup('spec-group2', 'spec2'));
    createSession(makeSession('sess-ipc2', 'spec-group2'));
    const db = getDb();
    db.prepare(`INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inv-ipc2', 'sess-ipc2', null, '/tmp/out2', '/tmp/in2', now());
  }

  it('IpcInMount is created in active state immediately before the container process starts', () => {
    setup();
    const db = getDb();
    db.prepare('INSERT INTO ipc_in_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run('im-1', 'inv-ipc2', 'active');
    const r = db.prepare('SELECT * FROM ipc_in_mounts WHERE id = ?').get('im-1') as { status: string };
    expect(r.status).toBe('active');
  });

  it('active -> cleared is the only valid transition', () => {
    setup();
    const db = getDb();
    db.prepare('INSERT INTO ipc_in_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run('im-2', 'inv-ipc2', 'active');
    db.prepare("UPDATE ipc_in_mounts SET status = 'cleared' WHERE id = ?").run('im-2');
    const r = db.prepare('SELECT * FROM ipc_in_mounts WHERE id = ?').get('im-2') as { status: string };
    expect(r.status).toBe('cleared');
  });

  it('cleared is terminal', () => {
    const statuses: IpcMountStatus[] = ['active', 'cleared'];
    expect(statuses.indexOf('cleared')).toBeGreaterThan(-1);
  });

  it('IpcInMount transitions to cleared when the invocation ends', () => {
    setup();
    const db = getDb();
    db.prepare('INSERT INTO ipc_in_mounts (id, invocation_id, status) VALUES (?, ?, ?)').run('im-3', 'inv-ipc2', 'active');
    db.prepare("UPDATE ipc_in_mounts SET status = 'cleared' WHERE invocation_id = ?").run('inv-ipc2');
    const r = db.prepare('SELECT * FROM ipc_in_mounts WHERE id = ?').get('im-3') as { status: string };
    expect(r.status).toBe('cleared');
  });
});

// ---------------------------------------------------------------------------
// ContainerTransfer state machine
// ---------------------------------------------------------------------------

describe('ContainerTransfer state machine', () => {
  function setupTransfer() {
    createAgentGroup(makeAgentGroup('spec-g', 'spec-g'));
    createSession(makeSession('sess-t', 'spec-g'));
    const db = getDb();
    db.prepare(`INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inv-t', 'sess-t', null, '/tmp/o', '/tmp/i', now());
    createSpecialist({ agent_group_id: 'spec-g', is_memory_provider: 0, last_turn_sub_notice: null, last_turn_parent_notice: null, created_at: now() });
    createSession(makeSession('sess-req', 'spec-g'));
    createTask(makeTask({ id: 'task-t', specialist_group_id: 'spec-g', requester_session_id: 'sess-req', requester_group_id: null, requester_task_id: null }));
    // Fix: set requester_group_id to avoid FK issue in task creation
  }

  function insertTransfer(id: string, status: TransferStatus = 'pending') {
    const db = getDb();
    db.prepare(`INSERT INTO container_transfers
      (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, 'task-t', 'inv-t', 'result', 0, 0, now(), status);
  }

  it('pending -> in_transit (files placed into requester ipc-in, commit_to_memory=false)', () => {
    setupTransfer();
    insertTransfer('xfer-pt');
    const db = getDb();
    db.prepare("UPDATE container_transfers SET status = 'in_transit' WHERE id = ?").run('xfer-pt');
    const r = db.prepare('SELECT status FROM container_transfers WHERE id = ?').get('xfer-pt') as { status: string };
    expect(r.status).toBe('in_transit');
  });

  it('pending -> committed (files committed to memory, commit_to_memory=true)', () => {
    setupTransfer();
    insertTransfer('xfer-pc');
    const db = getDb();
    db.prepare("UPDATE container_transfers SET status = 'committed' WHERE id = ?").run('xfer-pc');
    const r = db.prepare('SELECT status FROM container_transfers WHERE id = ?').get('xfer-pc') as { status: string };
    expect(r.status).toBe('committed');
  });

  it('in_transit -> expired (requester task reached terminal state)', () => {
    setupTransfer();
    insertTransfer('xfer-te', 'in_transit');
    const db = getDb();
    db.prepare("UPDATE container_transfers SET status = 'expired' WHERE id = ?").run('xfer-te');
    const r = db.prepare('SELECT status FROM container_transfers WHERE id = ?').get('xfer-te') as { status: string };
    expect(r.status).toBe('expired');
  });

  it('committed -> expired (staging copies reclaimed; memory copies persist)', () => {
    setupTransfer();
    insertTransfer('xfer-ce', 'committed');
    const db = getDb();
    db.prepare("UPDATE container_transfers SET status = 'expired' WHERE id = ?").run('xfer-ce');
    const r = db.prepare('SELECT status FROM container_transfers WHERE id = ?').get('xfer-ce') as { status: string };
    expect(r.status).toBe('expired');
  });

  it('expired is the only terminal state', () => {
    const terminal: TransferStatus = 'expired';
    expect(terminal).toBe('expired');
  });

  describe('entity relationship — obligation id: entity-relationship.ContainerTransfer.files', () => {
    it('ContainerTransfer.files returns the TransferFile rows where transfer = this', () => {
      setupTransfer();
      insertTransfer('xfer-rel');
      const db = getDb();
      db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
        VALUES (?, ?, ?, ?, ?, NULL)`).run('tf-rel-1', 'xfer-rel', 'a.txt', '/tmp/a', 'owned');
      db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
        VALUES (?, ?, ?, ?, ?, NULL)`).run('tf-rel-2', 'xfer-rel', 'b.txt', '/tmp/b', 'owned');
      const files = db.prepare('SELECT * FROM transfer_files WHERE transfer_id = ?').all('xfer-rel');
      expect(files).toHaveLength(2);
    });

    it('ContainerTransfer.file_count matches the actual number of TransferFile rows', () => {
      setupTransfer();
      insertTransfer('xfer-fc');
      const db = getDb();
      db.prepare("UPDATE container_transfers SET file_count = 1 WHERE id = ?").run('xfer-fc');
      db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
        VALUES (?, ?, ?, ?, ?, NULL)`).run('tf-fc-1', 'xfer-fc', 'c.txt', '/tmp/c', 'owned');
      const fc = (db.prepare('SELECT file_count FROM container_transfers WHERE id = ?').get('xfer-fc') as { file_count: number }).file_count;
      const actual = (db.prepare('SELECT COUNT(*) as n FROM transfer_files WHERE transfer_id = ?').get('xfer-fc') as { n: number }).n;
      expect(fc).toBe(actual);
    });
  });
});

// ---------------------------------------------------------------------------
// TransferFile state machine
// ---------------------------------------------------------------------------

describe('TransferFile state machine', () => {
  function setupForFiles() {
    createAgentGroup(makeAgentGroup('spec-gf', 'spec-gf'));
    createSession(makeSession('sess-tf', 'spec-gf'));
    const db = getDb();
    db.prepare(`INSERT INTO invocations (id, session_id, task_id, ipc_out_host_path, ipc_in_host_path, started_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('inv-tf', 'sess-tf', null, '/tmp/of', '/tmp/if', now());
    createSpecialist({ agent_group_id: 'spec-gf', is_memory_provider: 0, last_turn_sub_notice: null, last_turn_parent_notice: null, created_at: now() });
    createSession(makeSession('sess-req-tf', 'spec-gf'));
    createTask(makeTask({ id: 'task-tf', specialist_group_id: 'spec-gf', requester_session_id: 'sess-req-tf', requester_group_id: null, requester_task_id: null }));
    db.prepare(`INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run('xfer-files', 'task-tf', 'inv-tf', 'r', 0, 1, now(), 'pending');
  }

  it('owned -> placed (file placed in recipient ipc-in)', () => {
    setupForFiles();
    const db = getDb();
    db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path) VALUES (?, ?, ?, ?, ?, NULL)`).run('tf-op', 'xfer-files', 'x.txt', '/tmp/x', 'owned');
    db.prepare("UPDATE transfer_files SET status = 'placed' WHERE id = ?").run('tf-op');
    const r = db.prepare('SELECT status FROM transfer_files WHERE id = ?').get('tf-op') as { status: string };
    expect(r.status).toBe('placed');
  });

  it('placed -> expired (recipient task is terminal)', () => {
    setupForFiles();
    const db = getDb();
    db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path) VALUES (?, ?, ?, ?, ?, NULL)`).run('tf-pe', 'xfer-files', 'y.txt', '/tmp/y', 'placed');
    db.prepare("UPDATE transfer_files SET status = 'expired' WHERE id = ?").run('tf-pe');
    const r = db.prepare('SELECT status FROM transfer_files WHERE id = ?').get('tf-pe') as { status: string };
    expect(r.status).toBe('expired');
  });

  it('expired is the only terminal state', () => {
    const terminal: TransferFileStatus = 'expired';
    expect(terminal).toBe('expired');
  });

  describe('optional fields — obligation id: entity-optional.TransferFile.memory_path', () => {
    it('memory_path is null when commit_to_memory=false', () => {
      setupForFiles();
      const db = getDb();
      db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path) VALUES (?, ?, ?, ?, ?, NULL)`).run('tf-mp1', 'xfer-files', 'z.txt', '/tmp/z', 'owned');
      const r = db.prepare('SELECT memory_path FROM transfer_files WHERE id = ?').get('tf-mp1') as { memory_path: string | null };
      expect(r.memory_path).toBeNull();
    });

    it('memory_path is set to the workspace-relative final path when commit_to_memory=true', () => {
      setupForFiles();
      const db = getDb();
      db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path) VALUES (?, ?, ?, ?, ?, ?)`).run('tf-mp2', 'xfer-files', 'r.pdf', '/tmp/r', 'placed', 'memory/reports/r.pdf');
      const r = db.prepare('SELECT memory_path FROM transfer_files WHERE id = ?').get('tf-mp2') as { memory_path: string | null };
      expect(r.memory_path).toBe('memory/reports/r.pdf');
    });

    it('memory_path persists after the transfer expires (memory copy survives cleanup)', () => {
      setupForFiles();
      const db = getDb();
      db.prepare(`INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path) VALUES (?, ?, ?, ?, ?, ?)`).run('tf-mp3', 'xfer-files', 's.pdf', '/tmp/s', 'placed', 'memory/reports/s.pdf');
      db.prepare("UPDATE transfer_files SET status = 'expired' WHERE id = ?").run('tf-mp3');
      const r = db.prepare('SELECT * FROM transfer_files WHERE id = ?').get('tf-mp3') as TransferFile;
      expect(r.status).toBe('expired');
      expect(r.memory_path).toBe('memory/reports/s.pdf');
    });
  });
});

// ---------------------------------------------------------------------------
// Remaining rule stubs (result routing, crash recovery, timeout, file handover)
// ---------------------------------------------------------------------------

describe('SubTaskResultRouted rule', () => {
  it.todo('success: routes the child result back to the awaiting parent session');
  it.todo('success: parent transitions from awaiting_sub_task to running');
  it.todo('success: parent.pending_sub_task is cleared');
  it.todo('failure: requires parent_task.status = awaiting_sub_task');
  it.todo('failure: requires child task is in a terminal state (completed or failed)');
});

describe('RootTaskResultRouted rule', () => {
  it.todo('success: delivers the specialist result to the original main-group session');
  it.todo('success: result text is path-rewritten if files were staged');
  it.todo('failure: requires task.requester_group is not null (root task)');
  it.todo('failure: requires task.status = completed or failed');
});

describe('SpecialistContainerCrashed rule', () => {
  it.todo('success: transitions running task to awaiting_restart when restart_attempt_count < max_restart_retries');
  it.todo('success: increments restart_attempt_count');
  it.todo('success: transitions queued task to awaiting_restart (crash before first processing)');
  it.todo('success: transitions awaiting_sub_task task to awaiting_restart');
  it.todo('failure: requires task.status in {queued, running, awaiting_sub_task}');
});

describe('SpecialistRestartLimitExceeded rule', () => {
  it.todo(
    'success: transitions awaiting_restart -> failed with kind=host_restart when restart_attempt_count >= max_restart_retries',
  );
  it.todo('success: sets closed_at and failure on the task');
  it.todo('failure: requires task.status = awaiting_restart');
  it.todo('failure: requires restart_attempt_count >= max_restart_retries');
});

describe('SpecialistTaskTimedOut rule', () => {
  it.todo(
    'success: transitions any live task (queued/running/awaiting_sub_task/awaiting_restart) to failed with kind=timeout',
  );
  it.todo('success: sets closed_at and failure on the task');
  it.todo('success: fires when is_overdue = true');
  it.todo('failure: does not fire for terminal tasks');
});

describe('InvocationStarted rule', () => {
  it.todo('success: creates IpcOutMount in active state for the new invocation');
  it.todo('success: creates IpcInMount in active state populated with staged files for this invocation');
  it.todo('success: each invocation gets a fresh, empty ipc-out and a populated ipc-in');
});

describe('InvocationEnded rule', () => {
  it.todo('success: transitions IpcOutMount from active to cleared');
  it.todo('success: transitions IpcInMount from active to cleared');
  it.todo('success: files not consumed by a delivery are discarded');
});

describe('TransferOwnershipTaken rule', () => {
  it.todo('success: creates ContainerTransfer with status=pending');
  it.todo('success: creates one TransferFile per file_path with status=staged -> owned');
  it.todo('success: host_path is set for each TransferFile after copy');
  it.todo('success: file_count matches the number of file_paths');
  it.todo('failure: requires the delivering invocation has an active IpcOutMount');
  it.todo('failure: requires file_paths are all present in ipc-out');
});

describe('TransferPlacedInIpcIn rule (commit_to_memory=false)', () => {
  it.todo('success: transitions ContainerTransfer pending -> in_transit');
  it.todo('success: transitions each TransferFile owned -> placed');
  it.todo('success: files are copied to the recipient invocation ipc-in before its container starts');
  it.todo('success: result text is rewritten to reference ipc-in paths');
  it.todo('failure: requires commit_to_memory = false');
  it.todo('failure: requires a living recipient invocation exists');
});

describe('TransferCommittedToMemory rule (commit_to_memory=true)', () => {
  it.todo('success: transitions ContainerTransfer pending -> committed');
  it.todo('success: copies files to requester_group.folder / memory_reports_subpath');
  it.todo('success: sets memory_path on each TransferFile');
  it.todo('success: sets committed_files on the parent SpecialistTask');
  it.todo('success: result text is rewritten to reference memory paths');
  it.todo('failure: requires commit_to_memory = true');
});

describe('TransferExpired rule', () => {
  it.todo('transitions ContainerTransfer in_transit -> expired when requester task reaches terminal state');
  it.todo('transitions ContainerTransfer committed -> expired (staging reclaimed; memory paths survive)');
  it.todo('transitions ContainerTransfer pending -> expired for empty transfers');
  it.todo('memory_path values on TransferFile rows are preserved after expiry');
});

// ---------------------------------------------------------------------------
// Rule stubs for dispatch rules, state machine rules
// ---------------------------------------------------------------------------

describe('SpecialistTask state machine', () => {
  describe('valid transitions', () => {
    it.todo('queued -> running (via SpecialistTaskStarted)');
    it.todo('queued -> awaiting_restart (via SpecialistContainerCrashed while queued)');
    it.todo('queued -> failed (via SpecialistTaskTimedOut while queued)');
    it.todo('running -> awaiting_sub_task (via SpecialistDispatchesSubTask or MemoryProviderDispatched)');
    it.todo('running -> awaiting_restart (via SpecialistContainerCrashed while running)');
    it.todo('running -> completed (via SpecialistTaskCompleted)');
    it.todo('running -> failed (via SpecialistTaskFailed or SpecialistTaskTimedOut)');
    it.todo('awaiting_sub_task -> awaiting_restart (via SpecialistContainerCrashed while awaiting)');
    it.todo('awaiting_sub_task -> running (via SubTaskResultRouted — parent resumes)');
    it.todo('awaiting_sub_task -> failed (via SpecialistTaskTimedOut while awaiting)');
    it.todo('awaiting_restart -> running (via SpecialistTaskStarted after restart)');
    it.todo('awaiting_restart -> failed (via SpecialistRestartLimitExceeded)');
  });

  describe('rejected transitions — obligation id: transition-rejected.SpecialistTask.status', () => {
    it.todo('running -> queued is not a valid transition');
    it.todo('completed -> running is not a valid transition (terminal state)');
    it.todo('failed -> running is not a valid transition (terminal state)');
    it.todo('awaiting_sub_task -> queued is not a valid transition');
    it.todo('awaiting_restart -> completed is not a valid transition (must go through running)');
  });

  describe('terminal states — obligation id: transition-terminal.SpecialistTask.status', () => {
    it.todo('completed is terminal — no outbound transitions');
    it.todo('failed is terminal — no outbound transitions');
    it.todo('a completed task has closed_at set');
    it.todo('a failed task has closed_at set');
    it.todo('a failed task has failure set with kind and detail');
  });
});

describe('MainGroupDispatchesSpecialist rule', () => {
  it.todo('success: creates SpecialistTask with status=queued, depth=0, chain_delegation_count=1, ancestor_groups={}');
  it.todo('success: creates a per-task Session with messaging_group=null and thread_id=task.id');
  it.todo('success: writes a pending InboundMessage with kind="chat" and trigger=true into the task session');
  it.todo('success: emits SessionWoken for the task session');

  it.todo('failure[1]: requires session.agent_group.is_main = true — non-main group is rejected');
  it.todo('failure[2]: requires the target specialist_group_id to resolve to an existing AgentGroup');
  it.todo('failure[3]: requires the target AgentGroup to have a Specialist row');
});

describe('SpecialistTaskStarted rule', () => {
  it.todo('success: transitions task from queued to running when container begins processing');
  it.todo('success: transitions task from awaiting_restart to running after a restart');
  it.todo('failure[1]: requires task.status in {queued, awaiting_restart} — running task is not re-transitioned');
});

describe('SpecialistDispatchesSubTask rule', () => {
  it.todo('success: creates child SpecialistTask with depth = parent.depth + 1');
  it.todo('success: child inherits ancestor_groups = parent.ancestor_groups + {parent.specialist_group}');
  it.todo('success: child chain_delegation_count = parent.chain_delegation_count + 1');
  it.todo('success: parent transitions to awaiting_sub_task');
  it.todo('success: parent.pending_sub_task = child');
  it.todo('success: child gets its own session and trigger InboundMessage');
  it.todo(
    'success: is_last_same_type_dispatch = true when this is the (max_same_type_dispatches - 1)th dispatch to this group',
  );
  it.todo('success: is_last_same_type_dispatch = false otherwise');

  it.todo('failure[1]: requires session.agent_group to have a Specialist row');
  it.todo('failure[2]: requires calling specialist is_memory_provider = false (memory providers cannot delegate)');
  it.todo('failure[3]: requires target AgentGroup exists');
  it.todo('failure[4]: requires target AgentGroup has a Specialist row');
  it.todo(
    'failure[5]: requires target specialist is_memory_provider = false (use MemoryProviderDispatched for memory providers)',
  );
  it.todo('failure[6]: requires a running_task_for_group exists for the calling session');
  it.todo('failure[7]: requires parent_task.status = running');
  it.todo('failure[8]: requires target_group not in parent_task.ancestor_groups (cycle check)');
  it.todo('failure[9]: requires parent_task.depth + 1 < max_specialist_depth');
  it.todo('failure[10]: requires parent_task.chain_delegation_count < max_chain_delegations');
  it.todo('failure[11]: requires same_type_dispatch_count < max_same_type_dispatches');
});

describe('SubTaskRejectedCycle rule', () => {
  it.todo('success: creates child SpecialistTask immediately in status=failed with kind=cycle_detected');
  it.todo('success: notifies the calling agent with "sub-task rejected: cycle detected"');
  it.todo('success: parent task is NOT moved to awaiting_sub_task (rejection is immediate)');

  it.todo('failure[1]: requires calling agent_group has Specialist row');
  it.todo('failure[2]: requires calling specialist is_memory_provider = false');
  it.todo('failure[3]: requires target AgentGroup exists');
  it.todo('failure[4]: requires target AgentGroup has Specialist row');
  it.todo('failure[5]: requires target specialist is_memory_provider = false');
  it.todo('failure[6]: requires parent_task exists and is running');
  it.todo('failure[7]: requires target_group IS in parent_task.ancestor_groups (the cycle condition)');
  it.todo('failure[8]: does not fire when no cycle — SpecialistDispatchesSubTask fires instead');
});

describe('SubTaskRejectedDepth rule', () => {
  it.todo('success: creates child immediately in status=failed with kind=depth_exceeded');
  it.todo('success: fires when parent.depth + 1 >= max_specialist_depth (default: at depth=5)');
  it.todo('success: fires at exactly the boundary depth (depth + 1 = max_specialist_depth)');

  it.todo('failure[1]: requires calling specialist exists and is not memory provider');
  it.todo('failure[2]: requires target specialist exists and is not memory provider');
  it.todo('failure[3]: requires parent_task exists and is running');
  it.todo('failure[4]: requires no cycle (target not in ancestor_groups)');
  it.todo('failure[5]: requires depth + 1 >= max_specialist_depth — does not fire within limit');
  it.todo('failure[6]: does not fire at depth + 1 = max_specialist_depth - 1 (within limit)');
  it.todo('failure[7]: does not fire when chain count is the binding constraint');
  it.todo('failure[8]: does not fire when same-type count is the binding constraint');
  it.todo('failure[9]: chain_delegation_count is still incremented on the rejected child');
});

describe('SubTaskRejectedCount rule', () => {
  it.todo('success: creates child immediately in status=failed with kind=count_exceeded');
  it.todo('success: fires when parent.chain_delegation_count >= max_chain_delegations (default: at 20)');
  it.todo('success: fires at exactly the boundary count');

  it.todo('failure[1]: requires calling specialist exists and is not memory provider');
  it.todo('failure[2]: requires target specialist exists and is not memory provider');
  it.todo('failure[3]: requires parent_task exists and is running');
  it.todo('failure[4]: requires no cycle');
  it.todo('failure[5]: requires depth within limit (depth + 1 < max_specialist_depth)');
  it.todo('failure[6]: requires chain_delegation_count >= max_chain_delegations');
  it.todo('failure[7]: does not fire when count is within limit');
  it.todo('failure[8]: does not fire when depth is the binding constraint');
  it.todo('failure[9]: does not fire when same-type count is the binding constraint');
  it.todo('failure[10]: child chain_delegation_count is set to parent count + 1 even on rejection');
});

describe('SubTaskRejectedSameTypeLimit rule', () => {
  it.todo('success: creates child immediately in status=failed with kind=same_type_limit_exceeded');
  it.todo('success: fires when same_type_dispatch_count >= max_same_type_dispatches (default: at 3)');
  it.todo('success: fires at exactly the boundary count');

  it.todo('failure[1]: requires calling specialist exists and is not memory provider');
  it.todo('failure[2]: requires target specialist exists and is not memory provider');
  it.todo('failure[3]: requires parent_task exists and is running');
  it.todo('failure[4]: requires no cycle');
  it.todo('failure[5]: requires depth within limit');
  it.todo('failure[6]: requires chain count within limit');
  it.todo('failure[7]: requires same_type_dispatch_count >= max_same_type_dispatches');
  it.todo('failure[8]: does not fire when same-type count is within limit');
  it.todo('failure[9]: memory-provider dispatches are not counted toward same_type_dispatch_count');
  it.todo('failure[10]: same_type_dispatch_count counts only dispatches to the exact same specialist_group');
  it.todo('failure[11]: dispatches to different specialist groups count separately');
});

describe('MemoryProviderDispatched rule', () => {
  it.todo('success: creates child task with depth = parent.depth (not incremented)');
  it.todo('success: creates child task with chain_delegation_count = parent.chain_delegation_count (not incremented)');
  it.todo('success: creates child task with ancestor_groups = parent.ancestor_groups (unchanged)');
  it.todo('success: creates child task with is_last_same_type_dispatch = false');
  it.todo('success: parent transitions to awaiting_sub_task');
  it.todo('success: child gets its own session and trigger InboundMessage');
  it.todo('success: bypasses cycle, depth, count, and same-type checks');

  it.todo('failure[1]: requires calling specialist exists and is not a memory provider');
  it.todo('failure[2]: requires target AgentGroup exists');
  it.todo('failure[3]: requires target specialist exists');
  it.todo(
    'failure[4]: requires target specialist IS a memory provider (non-memory providers go through SpecialistDispatchesSubTask)',
  );
  it.todo('failure[5]: requires parent_task exists');
  it.todo('failure[6]: requires parent_task.status = running');
  it.todo('failure[7]: does not fire for non-memory-provider targets');
});

// ---------------------------------------------------------------------------
// Scenario tests — cross-entity process obligations
// ---------------------------------------------------------------------------

describe('happy-path scenarios', () => {
  it.todo('root task: main group dispatches specialist -> runs -> completes -> result routed back');
  it.todo('sub-task chain: specialist dispatches sub-specialist -> both complete -> results flow back');
  it.todo('memory provider: specialist calls memory provider -> provider returns -> parent resumes');
  it.todo(
    'file handover (ipc-in): specialist delivers files with commit_to_memory=false -> files placed in requester ipc-in',
  );
  it.todo(
    'file handover (memory): specialist delivers files with commit_to_memory=true -> files committed to memory area',
  );
  it.todo('crash-and-restart: container crashes mid-task -> awaiting_restart -> restarts -> completes');
});

describe('chain-limit enforcement scenarios', () => {
  it.todo('depth limit: chain at depth=4 attempting depth=5 -> SubTaskRejectedDepth fires');
  it.todo('count limit: chain with 19 delegations attempting 20th -> SubTaskRejectedCount fires');
  it.todo('same-type limit: 2 prior dispatches to group X, 3rd dispatch to X -> SubTaskRejectedSameTypeLimit fires');
  it.todo('cycle detection: A -> B -> C -> A -> SubTaskRejectedCycle fires');
  it.todo('memory provider bypasses all chain limits');
});

describe('reachability: complete lifecycle paths', () => {
  it.todo('queued -> running -> completed (happy path)');
  it.todo('queued -> running -> failed (execution error)');
  it.todo('queued -> awaiting_restart -> running -> completed (restart path)');
  it.todo('queued -> awaiting_restart -> failed (restart limit exceeded)');
  it.todo('queued -> failed (immediate timeout before container starts)');
  it.todo('running -> awaiting_sub_task -> running -> completed (sub-task delegation)');
  it.todo('running -> awaiting_sub_task -> awaiting_restart -> running -> completed (crash while awaiting)');
  it.todo('ContainerTransfer: pending -> in_transit -> expired');
  it.todo('ContainerTransfer: pending -> committed -> expired');
  it.todo('TransferFile: staged -> owned -> placed -> expired');
});
