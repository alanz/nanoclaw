/**
 * Result routing: delivers a completed/failed specialist task result back to
 * its requester (either the main group's session or the parent specialist's
 * per-task session).
 */
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import { getSpecialist, getTask, updateTaskStatus } from './db.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { findSessionByAgentGroupAndThread } from './session-helpers.js';
import type { SpecialistTask } from './types.js';

function generateId(): string {
  return `spec-res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatOutcome(task: SpecialistTask): string {
  if (task.status === 'completed' && task.result) return task.result;
  const kind = task.failure_kind ?? 'unknown';
  const detail = task.failure_detail ?? '';
  return `Specialist task failed: ${kind}${detail ? ` — ${detail}` : ''}`;
}

function lastTurnParentNotice(task: SpecialistTask): string {
  if (!task.is_last_same_type_dispatch) return '';
  const specialist = getSpecialist(task.specialist_group_id);
  return `\n\n${specialist?.last_turn_parent_notice ?? SPECIALISTS_CONFIG.defaultLastTurnParentNotice}`;
}

async function sendToSession(agentGroupId: string, sessionId: string, text: string, taskId: string): Promise<void> {
  writeSessionMessage(agentGroupId, sessionId, {
    id: generateId(),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      text,
      sender: 'system',
      senderId: 'system',
      specialistTaskId: taskId,
    }),
    trigger: 1,
  });
  const fresh = getSession(sessionId);
  if (fresh) {
    await wakeContainer(fresh).catch((err) =>
      log.error('specialists: failed to wake container after result routing', { err, taskId }),
    );
  }
}

/** Route a completed or failed root task result to the main group session. */
async function routeResultToMain(task: SpecialistTask): Promise<void> {
  const session = getSession(task.requester_session_id);
  if (!session) {
    log.warn('specialists: cannot route result to main — requester session not found', { taskId: task.id });
    return;
  }
  const content = formatOutcome(task) + lastTurnParentNotice(task);
  await sendToSession(session.agent_group_id, session.id, content, task.id);
}

/** Route a sub-task result to the parent specialist's per-task session, resuming the parent. */
async function routeResultToParent(task: SpecialistTask, parentTask: SpecialistTask): Promise<void> {
  const parentSession = findSessionByAgentGroupAndThread(parentTask.specialist_group_id, parentTask.id);
  if (!parentSession) {
    log.warn('specialists: cannot route result to parent — parent session not found', {
      taskId: task.id,
      parentTaskId: parentTask.id,
    });
    return;
  }
  updateTaskStatus(parentTask.id, 'running', { pending_sub_task_id: null });
  const content = formatOutcome(task) + lastTurnParentNotice(task);
  await sendToSession(parentSession.agent_group_id, parentSession.id, content, task.id);
}

/**
 * Route the result of a terminal task to its requester.
 * Immediately-rejected sub-tasks (cycle/depth/count/same-type) are skipped:
 * the parent never entered awaiting_sub_task, and AgentNotified was already
 * sent by the rejection handler.
 */
export async function routeResult(task: SpecialistTask): Promise<void> {
  if (task.requester_group_id) {
    await routeResultToMain(task);
    return;
  }
  if (!task.requester_task_id) return;

  const parent = getTask(task.requester_task_id);
  if (!parent) {
    log.warn('specialists: parent task not found for sub-task routing', {
      taskId: task.id,
      requesterTaskId: task.requester_task_id,
    });
    return;
  }
  if (parent.status !== 'awaiting_sub_task') return;
  await routeResultToParent(task, parent);
}
