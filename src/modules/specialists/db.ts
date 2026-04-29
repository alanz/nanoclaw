import { getDb } from '../../db/connection.js';
import type { Specialist, SpecialistTask, SpecialistTaskStatus } from './types.js';

// ── Specialists ──────────────────────────────────────────────────────────────

export function getSpecialist(agentGroupId: string): Specialist | undefined {
  return getDb().prepare('SELECT * FROM specialists WHERE agent_group_id = ?').get(agentGroupId) as
    | Specialist
    | undefined;
}

export function createSpecialist(s: Specialist): void {
  getDb()
    .prepare(
      `INSERT INTO specialists (agent_group_id, is_memory_provider, last_turn_sub_notice, last_turn_parent_notice, created_at)
       VALUES (@agent_group_id, @is_memory_provider, @last_turn_sub_notice, @last_turn_parent_notice, @created_at)`,
    )
    .run(s);
}

export function isMainGroup(agentGroupId: string): boolean {
  const row = getDb().prepare('SELECT is_main FROM agent_groups WHERE id = ?').get(agentGroupId) as
    | { is_main: number }
    | undefined;
  return row?.is_main === 1;
}

export function setMainGroup(agentGroupId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE agent_groups SET is_main = 0 WHERE is_main = 1').run();
    db.prepare('UPDATE agent_groups SET is_main = 1 WHERE id = ?').run(agentGroupId);
  })();
}

// ── SpecialistTask ────────────────────────────────────────────────────────────

export function createTask(task: SpecialistTask): void {
  getDb()
    .prepare(
      `INSERT INTO specialist_tasks
         (id, specialist_group_id, prompt, requester_group_id, requester_task_id,
          requester_session_id, depth, chain_delegation_count, ancestor_group_ids,
          is_last_same_type_dispatch, status, dispatched_at, restart_attempt_count,
          closed_at, result, failure_kind, failure_detail, pending_sub_task_id)
       VALUES
         (@id, @specialist_group_id, @prompt, @requester_group_id, @requester_task_id,
          @requester_session_id, @depth, @chain_delegation_count, @ancestor_group_ids,
          @is_last_same_type_dispatch, @status, @dispatched_at, @restart_attempt_count,
          @closed_at, @result, @failure_kind, @failure_detail, @pending_sub_task_id)`,
    )
    .run(task);
}

export function getTask(id: string): SpecialistTask | undefined {
  return getDb().prepare('SELECT * FROM specialist_tasks WHERE id = ?').get(id) as SpecialistTask | undefined;
}

export function getTaskBySessionThread(agentGroupId: string, threadId: string): SpecialistTask | undefined {
  return getDb()
    .prepare(
      `SELECT t.* FROM specialist_tasks t
       JOIN sessions s ON s.id = t.requester_session_id
       WHERE t.specialist_group_id = ? AND t.id = ?`,
    )
    .get(agentGroupId, threadId) as SpecialistTask | undefined;
}

/** Find the live (non-terminal) task for a specialist session identified by thread_id = task.id. */
export function getRunningTaskForGroup(agentGroupId: string): SpecialistTask | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM specialist_tasks
       WHERE specialist_group_id = ? AND status IN ('queued','running','awaiting_sub_task','awaiting_restart')
       ORDER BY dispatched_at DESC LIMIT 1`,
    )
    .get(agentGroupId) as SpecialistTask | undefined;
}

export function updateTaskStatus(
  id: string,
  status: SpecialistTaskStatus,
  extra?: Partial<
    Pick<
      SpecialistTask,
      'result' | 'failure_kind' | 'failure_detail' | 'closed_at' | 'pending_sub_task_id' | 'restart_attempt_count'
    >
  >,
): void {
  const fields: string[] = ['status = @status'];
  const params: Record<string, unknown> = { id, status };

  if (extra?.result !== undefined) {
    fields.push('result = @result');
    params.result = extra.result;
  }
  if (extra?.failure_kind !== undefined) {
    fields.push('failure_kind = @failure_kind');
    params.failure_kind = extra.failure_kind;
  }
  if (extra?.failure_detail !== undefined) {
    fields.push('failure_detail = @failure_detail');
    params.failure_detail = extra.failure_detail;
  }
  if (extra?.closed_at !== undefined) {
    fields.push('closed_at = @closed_at');
    params.closed_at = extra.closed_at;
  }
  if (extra?.pending_sub_task_id !== undefined) {
    fields.push('pending_sub_task_id = @pending_sub_task_id');
    params.pending_sub_task_id = extra.pending_sub_task_id;
  }
  if (extra?.restart_attempt_count !== undefined) {
    fields.push('restart_attempt_count = @restart_attempt_count');
    params.restart_attempt_count = extra.restart_attempt_count;
  }

  getDb()
    .prepare(`UPDATE specialist_tasks SET ${fields.join(', ')} WHERE id = @id`)
    .run(params);
}

/** Count how many times a parent task has dispatched to a given specialist group (excluding memory providers). */
export function sameTypeDispatchCount(parentTaskId: string, targetGroupId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM specialist_tasks
       WHERE requester_task_id = ? AND specialist_group_id = ?`,
    )
    .get(parentTaskId, targetGroupId) as { n: number };
  return row.n;
}

/** All live (non-terminal) tasks — used by the recovery sweep. */
export function getLiveTasksWithSessions(): Array<SpecialistTask & { session_id: string; container_status: string }> {
  return getDb()
    .prepare(
      `SELECT t.*, s.id AS session_id, s.container_status
       FROM specialist_tasks t
       JOIN sessions s ON s.agent_group_id = t.specialist_group_id AND s.thread_id = t.id
       WHERE t.status IN ('queued','running','awaiting_sub_task','awaiting_restart')
         AND s.status = 'active'`,
    )
    .all() as Array<SpecialistTask & { session_id: string; container_status: string }>;
}
