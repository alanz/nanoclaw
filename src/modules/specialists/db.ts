import { getDb } from '../../db/connection.js';
// The module owns these tables, so it owns registering their migrations.
import '../../db/migrations/module-specialists.js';
import '../../db/migrations/module-specialists-file-handover.js';
import '../../db/migrations/module-specialists-processing-state.js';
// agent_groups.is_main is created by the concurrency module and read here.
// Import it so this module's tables and the column it depends on always
// arrive together — module import is idempotent, so it registers once.
import '../concurrency/migration.js';
import type { Specialist, SpecialistTask, SpecialistTaskStatus } from './types.js';

// ── Specialists ──────────────────────────────────────────────────────────────

export async function getSpecialist(agentGroupId: string): Promise<Specialist | undefined> {
  return getDb().get<Specialist>('SELECT * FROM specialists WHERE agent_group_id = ?', agentGroupId);
}

export async function createSpecialist(s: Specialist): Promise<void> {
  await getDb().run(
    `INSERT INTO specialists (agent_group_id, is_memory_provider, last_turn_sub_notice, last_turn_parent_notice, created_at)
     VALUES (@agent_group_id, @is_memory_provider, @last_turn_sub_notice, @last_turn_parent_notice, @created_at)`,
    s,
  );
}

export async function isMainGroup(agentGroupId: string): Promise<boolean> {
  const row = await getDb().get<{ is_main: number }>('SELECT is_main FROM agent_groups WHERE id = ?', agentGroupId);
  return row?.is_main === 1;
}

export async function setMainGroup(agentGroupId: string): Promise<void> {
  const db = getDb();
  // One main group, always: demote-then-promote has to be atomic or a crash
  // between the two leaves an install with none.
  await db.transaction(async () => {
    await db.run('UPDATE agent_groups SET is_main = 0 WHERE is_main = 1');
    await db.run('UPDATE agent_groups SET is_main = 1 WHERE id = ?', agentGroupId);
  });
}

// ── SpecialistTask ────────────────────────────────────────────────────────────

export async function createTask(task: SpecialistTask): Promise<void> {
  await getDb().run(
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
    task,
  );
}

export async function getTask(id: string): Promise<SpecialistTask | undefined> {
  return getDb().get<SpecialistTask>('SELECT * FROM specialist_tasks WHERE id = ?', id);
}

/**
 * The live (non-terminal) task a specialist session works for. A specialist
 * task's session is the one whose thread_id is that task, in the task's own
 * agent group — the identity getLiveTasksWithSessions and the invocation code
 * use. Not "the newest live task in the group": with two tasks for one
 * specialist running at once, that answered for the wrong one.
 */
export async function getLiveTaskForSession(session: {
  agent_group_id: string;
  thread_id: string | null;
}): Promise<SpecialistTask | undefined> {
  if (!session.thread_id) return undefined;
  return getDb().get<SpecialistTask>(
    `SELECT * FROM specialist_tasks
     WHERE id = ? AND specialist_group_id = ?
       AND status IN ('queued','running','awaiting_sub_task','awaiting_restart')`,
    session.thread_id,
    session.agent_group_id,
  );
}

export async function updateTaskStatus(
  id: string,
  status: SpecialistTaskStatus,
  extra?: Partial<
    Pick<
      SpecialistTask,
      'result' | 'failure_kind' | 'failure_detail' | 'closed_at' | 'pending_sub_task_id' | 'restart_attempt_count'
    >
  >,
): Promise<void> {
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

  await getDb().run(`UPDATE specialist_tasks SET ${fields.join(', ')} WHERE id = @id`, params);
}

/** Count how many times a parent task has dispatched to a given specialist group (excluding memory providers). */
export async function sameTypeDispatchCount(parentTaskId: string, targetGroupId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM specialist_tasks
     WHERE requester_task_id = ? AND specialist_group_id = ?`,
    parentTaskId,
    targetGroupId,
  );
  return row?.n ?? 0;
}

/** All live (non-terminal) tasks — used by the recovery sweep. */
export async function getLiveTasksWithSessions(): Promise<
  Array<SpecialistTask & { session_id: string; container_status: string }>
> {
  return getDb().all<SpecialistTask & { session_id: string; container_status: string }>(
    `SELECT t.*, s.id AS session_id, s.container_status
     FROM specialist_tasks t
     JOIN sessions s ON s.agent_group_id = t.specialist_group_id AND s.thread_id = t.id
     WHERE t.status IN ('queued','running','awaiting_sub_task','awaiting_restart')
       AND s.status = 'active'`,
  );
}
