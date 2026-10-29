/**
 * Removing an agent group's specialist rows, for `ncl groups delete`.
 *
 * A group reaches these tables three ways: it is the specialist a task ran
 * on, it requested the task, or one of its sessions did. Its invocations and
 * transfers follow from those tasks and from its own sessions — including an
 * invocation of a deleted task that ran in another group's session, and a
 * transfer this group's invocation sent to another group's task. Everything
 * referencing one of those rows goes first, leaves to roots.
 *
 * A task below a deleted one goes with it, whatever group it ran in. A task
 * above one (a surviving parent whose pending sub-task was deleted) keeps its
 * row and loses only that pointer. By the time the rows go,
 * failTasksOfDeletedGroup has already ended that work.
 */
import { getDb, hasTable } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { registerGroupDeleteStep, registerGroupDeletionRequested } from '../../group-delete.js';
import { log } from '../../log.js';
import { getTask, updateTaskStatus } from './db.js';
import { cancelSubtree } from './recovery.js';
import { routeResult } from './routing.js';
import type { SpecialistTask } from './types.js';

/** The group's sessions. 1 param. */
const SESSIONS = 'SELECT id FROM sessions WHERE agent_group_id = ?';
/**
 * Tasks the group ran, requested, or requested from one of its sessions — and
 * every task below one of those, whatever group it ran in. A task below a
 * deleted one would otherwise survive with no requester (the spec's
 * ExactlyOneRequester); it has already been ended by failTasksOfDeletedGroup.
 * 3 params.
 */
const TASKS = `SELECT id FROM (
  WITH RECURSIVE doomed(id) AS (
    SELECT id FROM specialist_tasks
      WHERE specialist_group_id = ? OR requester_group_id = ? OR requester_session_id IN (${SESSIONS})
    UNION
    SELECT st.id FROM specialist_tasks st JOIN doomed d ON st.requester_task_id = d.id
  )
  SELECT id FROM doomed)`;
/** Invocations in the group's sessions or of its tasks. 4 params. */
const INVOCATIONS = `SELECT id FROM invocations WHERE session_id IN (${SESSIONS}) OR task_id IN (${TASKS})`;
/** Transfers of its tasks, sent by its invocations, or addressed to its sessions. 8 params. */
const TRANSFERS = `SELECT id FROM container_transfers
  WHERE task_id IN (${TASKS}) OR sender_invocation_id IN (${INVOCATIONS}) OR recipient_session_id IN (${SESSIONS})`;

const p = (id: string, n: number): string[] => Array(n).fill(id);

export async function deleteSpecialistRowsForGroup(db: DbDriver, id: string): Promise<number> {
  if (!(await hasTable(db, 'specialist_tasks'))) return 0;
  const handover = await hasTable(db, 'invocations');
  let removed = 0;

  if (handover) {
    removed += (await db.run(`DELETE FROM transfer_files WHERE transfer_id IN (${TRANSFERS})`, ...p(id, 8))).changes;
    removed += (await db.run(`DELETE FROM container_transfers WHERE id IN (${TRANSFERS})`, ...p(id, 8))).changes;
    removed += (await db.run(`DELETE FROM ipc_out_mounts WHERE invocation_id IN (${INVOCATIONS})`, ...p(id, 4)))
      .changes;
    removed += (await db.run(`DELETE FROM ipc_in_mounts WHERE invocation_id IN (${INVOCATIONS})`, ...p(id, 4))).changes;
    removed += (await db.run(`DELETE FROM invocations WHERE id IN (${INVOCATIONS})`, ...p(id, 4))).changes;
  }

  // The doomed set, fixed before anything changes: every task below a doomed
  // one is in it, so no surviving task points up into it by requester_task.
  // A surviving parent can still point down at one as its pending sub-task;
  // that pointer is cleared, and the doomed rows can then go in any order.
  const doomed = ((await db.all(TASKS, ...p(id, 3))) as { id: string }[]).map((r) => r.id);
  if (doomed.length === 0) {
    removed += (await db.run('DELETE FROM specialists WHERE agent_group_id = ?', id)).changes;
    return removed;
  }
  const marks = doomed.map(() => '?').join(', ');
  await db.run(`UPDATE specialist_tasks SET requester_task_id = NULL WHERE id IN (${marks})`, ...doomed);
  await db.run(
    `UPDATE specialist_tasks SET pending_sub_task_id = NULL WHERE pending_sub_task_id IN (${marks})`,
    ...doomed,
  );
  removed += (await db.run(`DELETE FROM specialist_tasks WHERE id IN (${marks})`, ...doomed)).changes;
  removed += (await db.run('DELETE FROM specialists WHERE agent_group_id = ?', id)).changes;
  return removed;
}

registerGroupDeleteStep({ name: 'specialists', run: deleteSpecialistRowsForGroup });

/**
 * Before a group is deleted, end the specialist work that depends on it
 * (spec: SpecialistTasksFailedOnGroupDeleted). Every live task the group runs,
 * or (as a root) requested, fails with group_deleted. A surviving requester is
 * told at once — a parent waiting on the task resumes with the failure rather
 * than sitting out its sub-task await — and a surviving child chain below the
 * task is cancelled. When the requester is itself in the deleted group the
 * task still ends cleanly (its session closed, its transfers expired) but
 * nothing is sent to, or wakes, a group that is going away. Clearing pointers
 * instead, as the row delete alone did, left surviving parents waiting up to
 * the 4h task timeout and surviving children with no requester.
 */
export async function failTasksOfDeletedGroup(agentGroupId: string): Promise<number> {
  const db = getDb();
  if (!(await hasTable(db, 'specialist_tasks'))) return 0;
  const live = (await db.all(
    `SELECT * FROM specialist_tasks
       WHERE status IN ('queued', 'running', 'awaiting_sub_task', 'awaiting_restart')
         AND (specialist_group_id = ? OR requester_group_id = ?)`,
    agentGroupId,
    agentGroupId,
  )) as SpecialistTask[];
  const ending = new Set(live.map((t) => t.id));

  for (const task of live) {
    const failure = {
      failure_kind: 'group_deleted' as const,
      failure_detail: 'specialist task ended: its agent group was deleted',
      closed_at: new Date().toISOString(),
      pending_sub_task_id: null,
    };
    await updateTaskStatus(task.id, 'failed', failure);

    const child = task.pending_sub_task_id;
    if (child && !ending.has(child)) await cancelSubtree(child);

    const parent = task.requester_task_id ? await getTask(task.requester_task_id) : undefined;
    const requesterGoing =
      task.requester_group_id === agentGroupId || (parent !== undefined && parent.specialist_group_id === agentGroupId);
    await routeResult({ ...task, status: 'failed', ...failure }, null, { notify: !requesterGoing });
  }
  if (live.length > 0) log.info('specialists: tasks ended by group deletion', { agentGroupId, tasks: live.length });
  return live.length;
}

registerGroupDeletionRequested({
  name: 'specialists',
  run: async (agentGroupId) => {
    await failTasksOfDeletedGroup(agentGroupId);
  },
});
