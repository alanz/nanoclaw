/**
 * Specialist dispatch handlers — processes dispatch_specialist and
 * dispatch_sub_task system actions from container agents.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { wakeContainer } from '../../container-runner.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import {
  createTask,
  getRunningTaskForGroup,
  getSpecialist,
  isMainGroup,
  sameTypeDispatchCount,
  updateTaskStatus,
} from './db.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { createSpecialistSession } from './session-helpers.js';
import { routeResult } from './routing.js';
import type { SpecialistTask } from './types.js';

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    trigger: 1,
  });
}

function formatTaskPrompt(task: SpecialistTask, specialist: ReturnType<typeof getSpecialist>): string {
  if (!task.is_last_same_type_dispatch) return task.prompt;
  const notice = specialist?.last_turn_sub_notice ?? SPECIALISTS_CONFIG.defaultLastTurnSubNotice;
  return `${task.prompt}\n\n${notice}`;
}

async function spawnTaskSession(task: SpecialistTask): Promise<void> {
  const session = createSpecialistSession(task.specialist_group_id, task.id);
  initSessionFolder(session.agent_group_id, session.id);
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `trigger-${task.id}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      text: task.prompt,
      sender: 'system',
      senderId: 'system',
      specialistTaskId: task.id,
    }),
    trigger: 1,
  });
  await wakeContainer(session).catch((err) =>
    log.error('specialists: failed to wake specialist container', { err, taskId: task.id }),
  );
}

// ── dispatch_specialist ─────────────────────────────────────────────────────

export async function handleDispatchSpecialist(content: Record<string, unknown>, session: Session): Promise<void> {
  const specialistGroupId = content.specialist_group_id as string;
  const prompt = content.prompt as string;

  if (!specialistGroupId || !prompt) {
    notifyAgent(session, 'dispatch_specialist failed: specialist_group_id and prompt are required.');
    return;
  }

  if (!isMainGroup(session.agent_group_id)) {
    notifyAgent(session, 'dispatch_specialist failed: only the main group may dispatch root specialist tasks.');
    log.warn('specialists: non-main group attempted dispatch_specialist', { agentGroupId: session.agent_group_id });
    return;
  }

  const targetGroup = getAgentGroup(specialistGroupId);
  if (!targetGroup) {
    notifyAgent(session, `dispatch_specialist failed: agent group "${specialistGroupId}" not found.`);
    return;
  }

  const specialist = getSpecialist(specialistGroupId);
  if (!specialist) {
    notifyAgent(session, `dispatch_specialist failed: agent group "${specialistGroupId}" is not a specialist.`);
    return;
  }

  const now = new Date().toISOString();
  const taskId = generateId();
  const task: SpecialistTask = {
    id: taskId,
    specialist_group_id: specialistGroupId,
    prompt,
    requester_group_id: session.agent_group_id,
    requester_task_id: null,
    requester_session_id: session.id,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'queued',
    dispatched_at: now,
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };
  createTask(task);
  await spawnTaskSession(task);

  notifyAgent(session, `Specialist task dispatched (id: ${taskId}). Result will arrive as a follow-up message.`);
  log.info('specialists: root task dispatched', { taskId, specialistGroupId, requesterGroup: session.agent_group_id });
}

// ── dispatch_sub_task ────────────────────────────────────────────────────────

export async function handleDispatchSubTask(content: Record<string, unknown>, session: Session): Promise<void> {
  const specialistGroupId = content.specialist_group_id as string;
  const prompt = content.prompt as string;

  if (!specialistGroupId || !prompt) {
    notifyAgent(session, 'dispatch_sub_task failed: specialist_group_id and prompt are required.');
    return;
  }

  const callerSpecialist = getSpecialist(session.agent_group_id);
  if (!callerSpecialist) {
    notifyAgent(session, 'dispatch_sub_task failed: caller is not a specialist agent group.');
    return;
  }
  if (callerSpecialist.is_memory_provider) {
    notifyAgent(session, 'dispatch_sub_task failed: memory providers cannot delegate sub-tasks.');
    return;
  }

  const targetGroup = getAgentGroup(specialistGroupId);
  if (!targetGroup) {
    notifyAgent(session, `dispatch_sub_task failed: agent group "${specialistGroupId}" not found.`);
    return;
  }

  const targetSpecialist = getSpecialist(specialistGroupId);
  if (!targetSpecialist) {
    notifyAgent(session, `dispatch_sub_task failed: agent group "${specialistGroupId}" is not a specialist.`);
    return;
  }

  const parentTask = getRunningTaskForGroup(session.agent_group_id);
  if (!parentTask) {
    notifyAgent(session, 'dispatch_sub_task failed: no running task found for this specialist session.');
    return;
  }
  if (parentTask.status !== 'running') {
    notifyAgent(
      session,
      `dispatch_sub_task failed: parent task is in state "${parentTask.status}", expected "running".`,
    );
    return;
  }

  const ancestorIds: string[] = JSON.parse(parentTask.ancestor_group_ids);
  const now = new Date().toISOString();

  // Memory provider — bypass chain checks, chain counters not incremented
  if (targetSpecialist.is_memory_provider) {
    const taskId = generateId();
    const child: SpecialistTask = {
      id: taskId,
      specialist_group_id: specialistGroupId,
      prompt,
      requester_group_id: null,
      requester_task_id: parentTask.id,
      requester_session_id: session.id,
      depth: parentTask.depth,
      chain_delegation_count: parentTask.chain_delegation_count,
      ancestor_group_ids: parentTask.ancestor_group_ids,
      is_last_same_type_dispatch: 0,
      status: 'queued',
      dispatched_at: now,
      restart_attempt_count: 0,
      closed_at: null,
      result: null,
      failure_kind: null,
      failure_detail: null,
      pending_sub_task_id: null,
      committed_files: null,
    };
    createTask(child);
    updateTaskStatus(parentTask.id, 'awaiting_sub_task', { pending_sub_task_id: taskId });
    await spawnTaskSession(child);
    log.info('specialists: memory provider dispatched', { taskId, specialistGroupId, parentTaskId: parentTask.id });
    return;
  }

  // Cycle check
  if (ancestorIds.includes(specialistGroupId)) {
    const taskId = generateId();
    const rejected: SpecialistTask = {
      id: taskId,
      specialist_group_id: specialistGroupId,
      prompt,
      requester_group_id: null,
      requester_task_id: parentTask.id,
      requester_session_id: session.id,
      depth: parentTask.depth + 1,
      chain_delegation_count: parentTask.chain_delegation_count + 1,
      ancestor_group_ids: JSON.stringify([...ancestorIds, parentTask.specialist_group_id]),
      is_last_same_type_dispatch: 0,
      status: 'failed',
      dispatched_at: now,
      restart_attempt_count: 0,
      closed_at: now,
      result: null,
      failure_kind: 'cycle_detected',
      failure_detail: 'target specialist appears in dispatch chain',
      pending_sub_task_id: null,
      committed_files: null,
    };
    createTask(rejected);
    notifyAgent(session, 'sub-task rejected: cycle detected');
    await routeResult(rejected);
    return;
  }

  // Depth limit
  if (parentTask.depth + 1 >= SPECIALISTS_CONFIG.maxSpecialistDepth) {
    const taskId = generateId();
    const rejected: SpecialistTask = {
      id: taskId,
      specialist_group_id: specialistGroupId,
      prompt,
      requester_group_id: null,
      requester_task_id: parentTask.id,
      requester_session_id: session.id,
      depth: parentTask.depth + 1,
      chain_delegation_count: parentTask.chain_delegation_count + 1,
      ancestor_group_ids: JSON.stringify([...ancestorIds, parentTask.specialist_group_id]),
      is_last_same_type_dispatch: 0,
      status: 'failed',
      dispatched_at: now,
      restart_attempt_count: 0,
      closed_at: now,
      result: null,
      failure_kind: 'depth_exceeded',
      failure_detail: 'specialist chain depth limit reached',
      pending_sub_task_id: null,
      committed_files: null,
    };
    createTask(rejected);
    notifyAgent(session, 'sub-task rejected: depth limit reached');
    await routeResult(rejected);
    return;
  }

  // Chain delegation count limit
  if (parentTask.chain_delegation_count >= SPECIALISTS_CONFIG.maxChainDelegations) {
    const taskId = generateId();
    const rejected: SpecialistTask = {
      id: taskId,
      specialist_group_id: specialistGroupId,
      prompt,
      requester_group_id: null,
      requester_task_id: parentTask.id,
      requester_session_id: session.id,
      depth: parentTask.depth + 1,
      chain_delegation_count: parentTask.chain_delegation_count + 1,
      ancestor_group_ids: JSON.stringify([...ancestorIds, parentTask.specialist_group_id]),
      is_last_same_type_dispatch: 0,
      status: 'failed',
      dispatched_at: now,
      restart_attempt_count: 0,
      closed_at: now,
      result: null,
      failure_kind: 'count_exceeded',
      failure_detail: 'specialist chain delegation count limit reached',
      pending_sub_task_id: null,
      committed_files: null,
    };
    createTask(rejected);
    notifyAgent(session, 'sub-task rejected: chain delegation limit reached');
    await routeResult(rejected);
    return;
  }

  // Same-type limit
  const sameCount = sameTypeDispatchCount(parentTask.id, specialistGroupId);
  if (sameCount >= SPECIALISTS_CONFIG.maxSameTypeDispatches) {
    const taskId = generateId();
    const rejected: SpecialistTask = {
      id: taskId,
      specialist_group_id: specialistGroupId,
      prompt,
      requester_group_id: null,
      requester_task_id: parentTask.id,
      requester_session_id: session.id,
      depth: parentTask.depth + 1,
      chain_delegation_count: parentTask.chain_delegation_count + 1,
      ancestor_group_ids: JSON.stringify([...ancestorIds, parentTask.specialist_group_id]),
      is_last_same_type_dispatch: 0,
      status: 'failed',
      dispatched_at: now,
      restart_attempt_count: 0,
      closed_at: now,
      result: null,
      failure_kind: 'same_type_limit_exceeded',
      failure_detail: 'specialist same-type dispatch limit reached',
      pending_sub_task_id: null,
      committed_files: null,
    };
    createTask(rejected);
    notifyAgent(session, 'sub-task rejected: same-type dispatch limit reached');
    await routeResult(rejected);
    return;
  }

  // Accepted dispatch
  const isLast = sameCount === SPECIALISTS_CONFIG.maxSameTypeDispatches - 1;
  const taskId = generateId();
  const child: SpecialistTask = {
    id: taskId,
    specialist_group_id: specialistGroupId,
    prompt,
    requester_group_id: null,
    requester_task_id: parentTask.id,
    requester_session_id: session.id,
    depth: parentTask.depth + 1,
    chain_delegation_count: parentTask.chain_delegation_count + 1,
    ancestor_group_ids: JSON.stringify([...ancestorIds, parentTask.specialist_group_id]),
    is_last_same_type_dispatch: isLast ? 1 : 0,
    status: 'queued',
    dispatched_at: now,
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };

  // Rewrite prompt with last-turn notice if this is the last allowed dispatch to this group
  if (isLast) {
    const childSpecialist = getSpecialist(specialistGroupId);
    child.prompt = formatTaskPrompt(child, childSpecialist);
  }

  createTask(child);
  updateTaskStatus(parentTask.id, 'awaiting_sub_task', { pending_sub_task_id: taskId });
  await spawnTaskSession(child);

  log.info('specialists: sub-task dispatched', {
    taskId,
    specialistGroupId,
    parentTaskId: parentTask.id,
    depth: child.depth,
  });
}
