/**
 * Specialist dispatch handlers — processes dispatch_specialist and
 * dispatch_sub_task system actions from container agents.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { wakeContainer } from '../../container-runner.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import { getNullMessagingGroupId } from '../../channels/null-channel.js';
import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import {
  createTask,
  getLiveTaskForSession,
  getSpecialist,
  isMainGroup,
  sameTypeDispatchCount,
  updateTaskStatus,
} from './db.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { createSpecialistSession } from './session-helpers.js';
import { routeResult } from './routing.js';
import { refusalNote, takeIpcOutFiles, type RefusedFile } from './delivery.js';
import type { Specialist, SpecialistTask } from './types.js';

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Tell the calling agent why its dispatch did not happen, and wake it. A
 * specialist's container exits as soon as it calls dispatch_sub_task, so by
 * the time a rejection is written there may be nothing running to read it —
 * left unwoken, the task sits `running` with no container until recovery
 * mistakes it for a crash.
 */
function notifyAgent(session: Session, text: string): void {
  void writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    trigger: true,
  })
    .then(() => getSession(session.id))
    .then((fresh) => (fresh ? requestWake(fresh, 'inbound-message') : false))
    .catch((err) => log.warn('specialists: failed to notify agent', { sessionId: session.id, err }));
}

/**
 * Note a successful dispatch in the caller's session as context only — no
 * trigger, no wake. The dispatch tool already told the agent; a triggering
 * note started a turn of its own after the agent's reply, and the agent
 * answered it to the user ("Noted. I'll send the report…"). The task id
 * stays visible with the agent's next message.
 */
function noteDispatched(session: Session, taskId: string, refused: RefusedFile[]): void {
  void writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      text:
        `Specialist task dispatched (id: ${taskId}). Result will arrive as a follow-up message.` + refusalNote(refused),
      sender: 'system',
      senderId: 'system',
    }),
    trigger: false,
  }).catch((err) => log.warn('specialists: failed to note dispatch', { sessionId: session.id, err }));
}

function formatTaskPrompt(task: SpecialistTask, specialist: Specialist | undefined): string {
  if (!task.is_last_same_type_dispatch) return task.prompt;
  const notice = specialist?.last_turn_sub_notice ?? SPECIALISTS_CONFIG.defaultLastTurnSubNotice;
  return `${task.prompt}\n\n${notice}`;
}

/**
 * Every task session lives on the null channel; without it the session cannot
 * be created, and a task row written first would be stranded — queued with no
 * session, invisible to the recovery sweep. So it is checked before anything
 * is created (spec: requires exists null_mg).
 */
async function nullChannelReady(session: Session, tool: string): Promise<boolean> {
  try {
    await getNullMessagingGroupId();
    return true;
  } catch (err) {
    log.error('specialists: cannot dispatch — no null channel for task sessions', { err });
    notifyAgent(session, `${tool} failed: specialist sessions are unavailable (the null channel is not set up).`);
    return false;
  }
}

/** The file_paths a dispatch names: absent, or a list of strings. */
function dispatchFilePaths(content: Record<string, unknown>): string[] {
  const raw = content.file_paths;
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
}

/**
 * The prompt as the specialist reads it, with the files handed over: listed
 * paths rewritten to the specialist's ipc-in, a list of the files (so one is
 * found even when the prompt never mentions its path), and any refused path
 * named (spec: dispatched_prompt).
 */
function dispatchedPrompt(rewritten: string, placed: string[], refused: RefusedFile[]): string {
  let prompt = rewritten;
  if (placed.length > 0) {
    prompt +=
      `\n\n[Files handed to you with this task (read-only; copy one into ${SPECIALISTS_CONFIG.ipcOutContainerPath} to return it): ` +
      `${placed.join(', ')}]`;
  }
  return prompt + refusalNote(refused);
}

/**
 * Provision the task's session and give it its trigger. Files the dispatch
 * names are taken from the dispatcher's ipc-out first — before a parent
 * specialist's exit clears it — and handed to the task as a dispatch transfer
 * its container finds in ipc-in at every start (spec: DispatchFilesTransferred).
 * The prompt that names them is recorded on the task, so a restart re-sends it.
 * Returns the paths that could not be handed over.
 */
async function spawnTaskSession(
  task: SpecialistTask,
  dispatcher: Session,
  filePaths: string[],
): Promise<RefusedFile[]> {
  const session = await createSpecialistSession(task.specialist_group_id, task.id);
  let refused: RefusedFile[] = [];
  if (filePaths.length > 0) {
    if (await getDb().hasTable('invocations')) {
      const taken = await takeIpcOutFiles(dispatcher, {
        kind: 'dispatch',
        taskId: task.id,
        text: task.prompt,
        filePaths,
        commitToMemory: false,
        recipientSessionId: session.id,
      });
      refused = taken.refused;
      task.prompt = dispatchedPrompt(taken.text, taken.placed, refused);
    } else {
      refused = filePaths.map((p) => ({ path: p, reason: 'file handover is not available' }));
      task.prompt = dispatchedPrompt(task.prompt, [], refused);
    }
    await getDb().run('UPDATE specialist_tasks SET prompt = ? WHERE id = ?', task.prompt, task.id);
  }
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
    trigger: true,
  });
  await wakeContainer(session).catch((err) =>
    log.error('specialists: failed to wake specialist container', { err, taskId: task.id }),
  );
  return refused;
}

// ── dispatch_specialist ─────────────────────────────────────────────────────

export async function handleDispatchSpecialist(content: Record<string, unknown>, session: Session): Promise<void> {
  const specialistGroupId = content.specialist_group_id as string;
  const prompt = content.prompt as string;

  if (!specialistGroupId || !prompt) {
    notifyAgent(session, 'dispatch_specialist failed: specialist_group_id and prompt are required.');
    return;
  }

  if (!(await isMainGroup(session.agent_group_id))) {
    notifyAgent(session, 'dispatch_specialist failed: only the main group may dispatch root specialist tasks.');
    log.warn('specialists: non-main group attempted dispatch_specialist', { agentGroupId: session.agent_group_id });
    return;
  }

  const targetGroup = await getAgentGroup(specialistGroupId);
  if (!targetGroup) {
    notifyAgent(session, `dispatch_specialist failed: agent group "${specialistGroupId}" not found.`);
    return;
  }

  const specialist = await getSpecialist(specialistGroupId);
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
  if (!(await nullChannelReady(session, 'dispatch_specialist'))) return;
  await createTask(task);
  const refused = await spawnTaskSession(task, session, dispatchFilePaths(content));

  noteDispatched(session, taskId, refused);
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

  const callerSpecialist = await getSpecialist(session.agent_group_id);
  if (!callerSpecialist) {
    notifyAgent(session, 'dispatch_sub_task failed: caller is not a specialist agent group.');
    return;
  }
  if (callerSpecialist.is_memory_provider) {
    notifyAgent(session, 'dispatch_sub_task failed: memory providers cannot delegate sub-tasks.');
    return;
  }

  const targetGroup = await getAgentGroup(specialistGroupId);
  if (!targetGroup) {
    notifyAgent(session, `dispatch_sub_task failed: agent group "${specialistGroupId}" not found.`);
    return;
  }

  const targetSpecialist = await getSpecialist(specialistGroupId);
  if (!targetSpecialist) {
    notifyAgent(session, `dispatch_sub_task failed: agent group "${specialistGroupId}" is not a specialist.`);
    return;
  }

  const parentTask = await getLiveTaskForSession(session);
  if (!parentTask) {
    notifyAgent(session, 'dispatch_sub_task failed: no running task found for this specialist session.');
    return;
  }
  // The call itself proves the parent's container is up — the same evidence
  // the recovery sweep uses to advance queued / awaiting_restart to running,
  // but the sweep runs once a minute. A specialist that delegates in its first
  // minute was rejected and had to retry (seen live).
  if (parentTask.status === 'queued' || parentTask.status === 'awaiting_restart') {
    log.info('specialists: task advanced to running by its own dispatch', {
      taskId: parentTask.id,
      from: parentTask.status,
    });
    await updateTaskStatus(parentTask.id, 'running');
    parentTask.status = 'running';
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
    if (!(await nullChannelReady(session, 'dispatch_sub_task'))) return;
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
    await createTask(child);
    await updateTaskStatus(parentTask.id, 'awaiting_sub_task', { pending_sub_task_id: taskId });
    await spawnTaskSession(child, session, dispatchFilePaths(content));
    log.info('specialists: memory provider dispatched', { taskId, specialistGroupId, parentTaskId: parentTask.id });
    return;
  }

  // No cycle check (specs/specialists.allium): a parent runs one sub-task at
  // a time, so a chain is a single line, and the depth, chain-count and
  // same-type limits below bound it — self-dispatch and returning to an
  // earlier group included.

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
    await createTask(rejected);
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
    await createTask(rejected);
    notifyAgent(session, 'sub-task rejected: chain delegation limit reached');
    await routeResult(rejected);
    return;
  }

  // Same-type limit
  const sameCount = await sameTypeDispatchCount(parentTask.id, specialistGroupId);
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
    await createTask(rejected);
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
    const childSpecialist = await getSpecialist(specialistGroupId);
    child.prompt = formatTaskPrompt(child, childSpecialist);
  }

  if (!(await nullChannelReady(session, 'dispatch_sub_task'))) return;
  await createTask(child);
  await updateTaskStatus(parentTask.id, 'awaiting_sub_task', { pending_sub_task_id: taskId });
  // A refused path reaches the parent through its child, whose prompt names it.
  await spawnTaskSession(child, session, dispatchFilePaths(content));

  log.info('specialists: sub-task dispatched', {
    taskId,
    specialistGroupId,
    parentTaskId: parentTask.id,
    depth: child.depth,
  });
}
