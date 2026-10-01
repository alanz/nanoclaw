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
 * A task in a surviving group that pointed at a deleted one (its requester, or
 * its pending sub-task) keeps its own row and loses only that pointer.
 */
import { hasTable } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { registerGroupDeleteStep } from '../../group-delete.js';

/** The group's sessions. 1 param. */
const SESSIONS = 'SELECT id FROM sessions WHERE agent_group_id = ?';
/** Tasks the group ran, requested, or requested from one of its sessions. 3 params. */
const TASKS = `SELECT id FROM specialist_tasks
  WHERE specialist_group_id = ? OR requester_group_id = ? OR requester_session_id IN (${SESSIONS})`;
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

  // Pointers into the doomed tasks, from any task — surviving ones keep their
  // row, and doomed ones can then be deleted in any order.
  await db.run(
    `UPDATE specialist_tasks SET requester_task_id = NULL WHERE requester_task_id IN (${TASKS})`,
    ...p(id, 3),
  );
  await db.run(
    `UPDATE specialist_tasks SET pending_sub_task_id = NULL WHERE pending_sub_task_id IN (${TASKS})`,
    ...p(id, 3),
  );
  removed += (await db.run(`DELETE FROM specialist_tasks WHERE id IN (${TASKS})`, ...p(id, 3))).changes;
  removed += (await db.run('DELETE FROM specialists WHERE agent_group_id = ?', id)).changes;
  return removed;
}

registerGroupDeleteStep({ name: 'specialists', run: deleteSpecialistRowsForGroup });
