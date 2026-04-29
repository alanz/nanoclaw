/**
 * deliver_specialist_result system-action handler.
 * Called when the specialist container writes a deliver_specialist_result
 * system action to its outbound DB. Marks the task completed, then routes
 * the result to the requester.
 *
 * File-handover (IpcOutMount / ContainerTransfer) is not yet implemented;
 * file_paths is accepted but ignored in this version.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getRunningTaskForGroup, updateTaskStatus } from './db.js';
import { routeResult } from './routing.js';

export async function handleDeliverSpecialistResult(content: Record<string, unknown>, session: Session): Promise<void> {
  const resultText = content.result_text as string | undefined;

  if (!resultText) {
    log.warn('specialists: deliver_specialist_result missing result_text', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const task = getRunningTaskForGroup(session.agent_group_id);
  if (!task) {
    log.warn('specialists: deliver_specialist_result — no running task for agent group', {
      agentGroupId: session.agent_group_id,
    });
    return;
  }
  if (task.status !== 'running') {
    log.warn('specialists: deliver_specialist_result — task not in running state', {
      taskId: task.id,
      status: task.status,
    });
    return;
  }

  const now = new Date().toISOString();
  updateTaskStatus(task.id, 'completed', {
    result: resultText,
    closed_at: now,
  });

  const completed = { ...task, status: 'completed' as const, result: resultText, closed_at: now };
  await routeResult(completed);

  log.info('specialists: task completed', { taskId: task.id, agentGroupId: session.agent_group_id });
}
