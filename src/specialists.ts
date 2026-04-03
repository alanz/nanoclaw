/**
 * Specialist task orchestration — implements specialists.allium and delegation-policy.allium.
 *
 * All functions are async-safe and operate against the SQLite DB via db.ts helpers.
 * Container lifecycle is injected via initSpecialists() so this module is testable
 * without a running container runtime.
 */
import crypto from 'crypto';

import { SPECIALISTS_CONFIG } from './config.js';
import {
  checkDelegationPolicy,
  DelegationDecision,
} from './delegation-policy.js';
import {
  createRawMemorySubmission,
  createSpecialistSession,
  createSpecialistTask,
  getRawMemorySubmission,
  getRawMemorySubmissionsByStatus,
  getSameTypeDispatchCount,
  getSpecialistSession,
  getSpecialistTask,
  getSpecialistTasksByStatus,
  updateRawMemorySubmission,
  updateSpecialistSession,
  updateSpecialistTask,
} from './db.js';
import { logger } from './logger.js';
import { getSpecialistType } from './specialist-types.js';
import { FailureKind, SpecialistTask } from './types.js';

// ---------------------------------------------------------------------------
// Injectable dependencies
// ---------------------------------------------------------------------------

export interface SpecialistDeps {
  /** Called to start (or restart) a specialist container. inject is the completed sub-task
   *  whose result should be fed into the resumed conversation, or null for a cold start. */
  startContainerFn: (
    task: SpecialistTask,
    inject?: SpecialistTask | null,
  ) => Promise<void>;
  /** Post a message to a group JID (used to notify the main group of results/failures). */
  notifyMainGroupFn: (groupJid: string, message: string) => Promise<void>;
}

let _deps: SpecialistDeps = {
  startContainerFn: async () => {
    logger.warn(
      'startContainerFn not initialised — specialist container not started',
    );
  },
  notifyMainGroupFn: async () => {
    logger.warn('notifyMainGroupFn not initialised — main group not notified');
  },
};

export function initSpecialists(deps: Partial<SpecialistDeps>): void {
  _deps = { ..._deps, ...deps };
}

/** @internal — for tests only. Restore default (no-op) deps. */
export function _resetSpecialistDepsForTest(): void {
  _deps = {
    startContainerFn: async () => {},
    notifyMainGroupFn: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Delegation outcome type
// ---------------------------------------------------------------------------

export type DelegationOutcome =
  | { ok: true }
  | { ok: false; rejection: DelegationDecision };

// ---------------------------------------------------------------------------
// 5b — Task dispatch from main group (MainDispatchesSpecialistTask)
// ---------------------------------------------------------------------------

/**
 * Dispatch a new specialist task from the main group.
 * Creates the DB record in queued state and starts the container.
 *
 * @throws if the specialist type is unknown
 */
export async function dispatchSpecialist(
  requesterGroupJid: string,
  typeName: string,
  prompt: string,
): Promise<SpecialistTask> {
  const type = getSpecialistType(typeName);
  if (!type) {
    throw new Error(`Unknown specialist type: "${typeName}"`);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  createSpecialistTask({
    id,
    specialist_type: typeName,
    prompt,
    requester_group: requesterGroupJid,
    requester_task_id: null,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_types: '[]',
    is_last_same_type_dispatch: false,
    status: 'queued',
    pending_sub_task_id: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    restart_attempt_count: 0,
    delegated_at: now,
    closed_at: null,
  });

  const task = getSpecialistTask(id)!;

  logger.info(
    { taskId: id, typeName, requesterGroupJid },
    'Specialist task queued',
  );

  await _deps.startContainerFn(task, null);

  return task;
}

// ---------------------------------------------------------------------------
// 5c — Sub-task dispatch from running specialist (SpecialistDispatchesSubTask)
// ---------------------------------------------------------------------------

/**
 * Handle a sub-task dispatch request from a running specialist container.
 * Evaluates delegation policy and either creates the sub-task or records a rejection.
 */
export async function dispatchSubTask(
  parentTaskId: string,
  parentTypeName: string,
  targetTypeName: string,
  prompt: string,
  sessionId: string,
): Promise<DelegationOutcome> {
  const parentTask = getSpecialistTask(parentTaskId);
  if (!parentTask) {
    throw new Error(`Parent task not found: ${parentTaskId}`);
  }
  if (parentTask.status !== 'running') {
    throw new Error(
      `Parent task ${parentTaskId} is not running (status: ${parentTask.status})`,
    );
  }

  const parentType = getSpecialistType(parentTypeName);
  if (!parentType) {
    throw new Error(`Unknown parent specialist type: "${parentTypeName}"`);
  }

  // Memory provider dispatches go via handleMemoryQuery, not here
  const targetType = getSpecialistType(targetTypeName);
  if (!targetType) {
    throw new Error(`Unknown target specialist type: "${targetTypeName}"`);
  }

  if (targetType.isMemoryProvider) {
    throw new Error(
      `Memory provider "${targetTypeName}" must be dispatched via handleMemoryQuery`,
    );
  }

  // Compute same-type count and evaluate policy
  const sameTypeCount = getSameTypeDispatchCount(parentTaskId, targetTypeName);
  const decision = checkDelegationPolicy(
    parentTask,
    parentType,
    targetType,
    sameTypeCount,
  );

  const now = new Date().toISOString();
  const subId = crypto.randomUUID();
  const ancestorTypes: string[] = JSON.parse(parentTask.ancestor_types);
  const newAncestors = JSON.stringify([...ancestorTypes, parentTypeName]);

  if (decision.outcome === 'rejected') {
    // Record a failed task for audit; parent stays running
    createSpecialistTask({
      id: subId,
      specialist_type: targetTypeName,
      prompt,
      requester_group: null,
      requester_task_id: parentTaskId,
      depth: parentTask.depth + 1,
      chain_delegation_count: parentTask.chain_delegation_count + 1,
      ancestor_types: newAncestors,
      is_last_same_type_dispatch: false,
      status: 'failed',
      pending_sub_task_id: null,
      result: null,
      failure_kind: decision.rejectionKind,
      failure_detail: decision.rejectionDetail,
      restart_attempt_count: 0,
      delegated_at: now,
      closed_at: now,
    });

    logger.warn(
      { parentTaskId, targetTypeName, rejectionKind: decision.rejectionKind },
      'Specialist sub-task dispatch rejected by policy',
    );

    return { ok: false, rejection: decision };
  }

  // Allowed: compute is_last flag, save session, create sub-task
  const isLast = sameTypeCount === SPECIALISTS_CONFIG.maxSameTypeDispatches - 1;

  // Save parent session before it exits
  await reportSession(parentTaskId, sessionId);

  createSpecialistTask({
    id: subId,
    specialist_type: targetTypeName,
    prompt,
    requester_group: null,
    requester_task_id: parentTaskId,
    depth: parentTask.depth + 1,
    chain_delegation_count: parentTask.chain_delegation_count + 1,
    ancestor_types: newAncestors,
    is_last_same_type_dispatch: isLast,
    status: 'queued',
    pending_sub_task_id: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    restart_attempt_count: 0,
    delegated_at: now,
    closed_at: null,
  });

  // Transition parent to awaiting_sub_task
  updateSpecialistTask(parentTaskId, {
    status: 'awaiting_sub_task',
    pending_sub_task_id: subId,
  });

  const subTask = getSpecialistTask(subId)!;

  logger.info(
    { parentTaskId, subTaskId: subId, targetTypeName, isLast },
    'Specialist sub-task created',
  );

  await _deps.startContainerFn(subTask, null);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 5d — Memory query dispatch (SpecialistQueriesMemory)
// ---------------------------------------------------------------------------

/**
 * Dispatch a memory query from a running specialist. Bypasses delegation policy.
 */
export async function handleMemoryQuery(
  queryingTaskId: string,
  targetTypeName: string,
  prompt: string,
  sessionId: string,
): Promise<void> {
  const queryingTask = getSpecialistTask(queryingTaskId);
  if (!queryingTask) {
    throw new Error(`Querying task not found: ${queryingTaskId}`);
  }
  if (queryingTask.status !== 'running') {
    throw new Error(`Querying task ${queryingTaskId} is not running`);
  }

  const targetType = getSpecialistType(targetTypeName);
  if (!targetType?.isMemoryProvider) {
    throw new Error(
      `"${targetTypeName}" is not a memory provider — use dispatchSubTask instead`,
    );
  }

  const now = new Date().toISOString();
  const memId = crypto.randomUUID();
  const ancestorTypes: string[] = JSON.parse(queryingTask.ancestor_types);
  const newAncestors = JSON.stringify([
    ...ancestorTypes,
    queryingTask.specialist_type,
  ]);

  await reportSession(queryingTaskId, sessionId);

  createSpecialistTask({
    id: memId,
    specialist_type: targetTypeName,
    prompt,
    requester_group: null,
    requester_task_id: queryingTaskId,
    depth: queryingTask.depth + 1,
    chain_delegation_count: queryingTask.chain_delegation_count + 1,
    ancestor_types: newAncestors,
    is_last_same_type_dispatch: false,
    status: 'queued',
    pending_sub_task_id: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    restart_attempt_count: 0,
    delegated_at: now,
    closed_at: null,
  });

  updateSpecialistTask(queryingTaskId, {
    status: 'awaiting_sub_task',
    pending_sub_task_id: memId,
  });

  const memTask = getSpecialistTask(memId)!;

  logger.info(
    { queryingTaskId, memTaskId: memId, targetTypeName },
    'Memory query dispatched',
  );

  await _deps.startContainerFn(memTask, null);
}

// ---------------------------------------------------------------------------
// 5e — Result delivery (SpecialistTaskCompleted + ParentSpecialistResumed)
// ---------------------------------------------------------------------------

/**
 * Record a successful result from a completed specialist container.
 * Marks the task completed and routes the result to the requester.
 */
export async function deliverResult(
  taskId: string,
  resultText: string,
): Promise<void> {
  const task = getSpecialistTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'running') {
    throw new Error(
      `deliverResult: task ${taskId} is not running (status: ${task.status})`,
    );
  }

  const now = new Date().toISOString();
  updateSpecialistTask(taskId, {
    status: 'completed',
    result: resultText,
    closed_at: now,
  });

  const session = getSpecialistSession(taskId);
  if (session) {
    updateSpecialistSession(taskId, { status: 'cleared' });
  }

  logger.info({ taskId }, 'Specialist task completed');

  await _routeResult(task, resultText);
}

// ---------------------------------------------------------------------------
// 5f — Failure propagation
// ---------------------------------------------------------------------------

/**
 * Fail a specialist task and propagate the failure to the requester.
 */
export async function failSpecialistTask(
  taskId: string,
  kind: FailureKind,
  detail: string,
): Promise<void> {
  const task = getSpecialistTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status === 'completed' || task.status === 'failed') {
    throw new Error(
      `failSpecialistTask: task ${taskId} is already terminal (status: ${task.status})`,
    );
  }

  const now = new Date().toISOString();
  updateSpecialistTask(taskId, {
    status: 'failed',
    failure_kind: kind,
    failure_detail: detail,
    closed_at: now,
  });

  const session = getSpecialistSession(taskId);
  if (session) {
    updateSpecialistSession(taskId, { status: 'cleared' });
  }

  logger.warn({ taskId, kind, detail }, 'Specialist task failed');

  await _routeFailure(task, kind, detail);
}

// ---------------------------------------------------------------------------
// 5g — Session tracking (SpecialistSessionEstablished)
// ---------------------------------------------------------------------------

/**
 * Record or update the Claude conversation session for a running specialist.
 */
export async function reportSession(
  taskId: string,
  sessionId: string,
): Promise<void> {
  const existing = getSpecialistSession(taskId);
  if (existing) {
    updateSpecialistSession(taskId, {
      session_id: sessionId,
      status: 'active',
    });
  } else {
    createSpecialistSession({
      task_id: taskId,
      session_id: sessionId,
      status: 'active',
    });
  }
  logger.debug({ taskId, sessionId }, 'Specialist session recorded');
}

// ---------------------------------------------------------------------------
// 5h — Container lifecycle (startSpecialistContainer)
// ---------------------------------------------------------------------------

/**
 * Start (or restart) a specialist container by invoking the injected startContainerFn.
 * Transitions the task from queued/awaiting_restart to running.
 * If inject is provided, the sub-task result is fed into the resumed conversation.
 */
export async function startSpecialistContainer(
  task: SpecialistTask,
  inject?: SpecialistTask | null,
): Promise<void> {
  await _deps.startContainerFn(task, inject ?? null);
}

// ---------------------------------------------------------------------------
// Memory write path (SpecialistSubmitsRawMemory / MemorySubmissionAccepted)
// ---------------------------------------------------------------------------

/**
 * A running specialist submits raw information to the main group's memory staging area.
 * Synchronous from the specialist's perspective — it does not exit after this call.
 */
export async function submitRawMemory(
  taskId: string,
  topic: string,
  stagingPath: string,
  mainGroupJid: string,
): Promise<void> {
  const task = getSpecialistTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'running') {
    throw new Error(`submitRawMemory: task ${taskId} is not running`);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  createRawMemorySubmission({
    id,
    task_id: taskId,
    topic,
    staging_path: stagingPath,
    submitted_at: now,
    accepted_at: null,
    final_path: null,
    status: 'staged',
  });

  const notice = _memorySubmissionNotice(task, topic, stagingPath);
  await _deps.notifyMainGroupFn(mainGroupJid, notice);

  logger.info({ taskId, topic, stagingPath }, 'Raw memory submitted');
}

/**
 * The main group has reviewed a staged submission and filed it at its permanent location.
 */
export async function acceptMemorySubmission(
  submissionId: string,
  finalPath: string,
): Promise<void> {
  const submission = getRawMemorySubmission(submissionId);
  if (!submission) throw new Error(`Submission not found: ${submissionId}`);
  if (submission.status !== 'staged') {
    throw new Error(
      `acceptMemorySubmission: submission ${submissionId} is not staged (status: ${submission.status})`,
    );
  }

  const now = new Date().toISOString();
  updateRawMemorySubmission(submissionId, {
    status: 'accepted',
    accepted_at: now,
    final_path: finalPath,
  });

  logger.info({ submissionId, finalPath }, 'Memory submission accepted');
}

// ---------------------------------------------------------------------------
// 5i — Startup recovery (NanoclawStarted)
// ---------------------------------------------------------------------------

/**
 * Called once at host startup. Recovers specialist tasks that were live when
 * the host was previously killed.
 *
 * - running tasks: retry if attempts remain, else fail with host_restart
 * - awaiting_sub_task tasks: re-trigger parent resume if sub-task is terminal
 * - staged memory submissions: re-notify main group
 */
export async function handleNanoclawStarted(
  mainGroupJid?: string,
): Promise<void> {
  const runningTasks = getSpecialistTasksByStatus('running');
  const awaitingTasks = getSpecialistTasksByStatus('awaiting_sub_task');

  if (runningTasks.length > 0) {
    logger.warn(
      { count: runningTasks.length },
      'Specialist tasks found running at startup — recovering',
    );
  }

  const retryingTaskIds: string[] = [];

  for (const task of runningTasks) {
    if (task.restart_attempt_count < SPECIALISTS_CONFIG.maxRestartRetries) {
      // Schedule a silent per-task retry (no individual chat notification)
      updateSpecialistTask(task.id, {
        restart_attempt_count: task.restart_attempt_count + 1,
        status: 'awaiting_restart',
      });

      const session = getSpecialistSession(task.id);
      if (session && session.status === 'active') {
        updateSpecialistSession(task.id, { status: 'stale' });
      }

      logger.warn(
        {
          taskId: task.id,
          attempt: task.restart_attempt_count + 1,
          max: SPECIALISTS_CONFIG.maxRestartRetries,
        },
        'Specialist task scheduled for retry after host restart',
      );

      retryingTaskIds.push(task.id);
      const updated = getSpecialistTask(task.id)!;
      await _deps.startContainerFn(updated, null);
    } else {
      // Retries exhausted — fail and propagate
      await failSpecialistTask(
        task.id,
        'host_restart',
        'Container lost on host restart; retries exhausted',
      );

      if (mainGroupJid) {
        await _deps.notifyMainGroupFn(
          mainGroupJid,
          `Specialist task ${task.id} (${task.specialist_type}) failed: retries exhausted after host restart.`,
        );
      }
    }
  }

  // Post a single consolidated summary when some tasks are being retried
  if (retryingTaskIds.length > 0 && mainGroupJid) {
    const summary = `Host restart detected: ${retryingTaskIds.length} specialist task(s) scheduled for retry: ${retryingTaskIds.join(', ')}.`;
    logger.warn({ taskIds: retryingTaskIds }, summary);
    await _deps.notifyMainGroupFn(mainGroupJid, summary);
  }

  // awaiting_sub_task: if sub-task is already terminal, resume parent immediately
  for (const task of awaitingTasks) {
    if (!task.pending_sub_task_id) continue;
    const subTask = getSpecialistTask(task.pending_sub_task_id);
    if (!subTask) continue;
    if (subTask.status === 'completed' || subTask.status === 'failed') {
      logger.info(
        { taskId: task.id, subTaskId: subTask.id, subStatus: subTask.status },
        'Sub-task already terminal at restart — resuming parent',
      );
      await _deps.startContainerFn(task, subTask);
    }
  }

  // Re-notify main group about any staged memory submissions that were never processed
  if (mainGroupJid) {
    const staged = getRawMemorySubmissionsByStatus('staged');
    for (const submission of staged) {
      const subTask = getSpecialistTask(submission.task_id);
      if (!subTask) continue;
      const notice = _memorySubmissionNotice(
        subTask,
        submission.topic,
        submission.staging_path,
      );
      await _deps.notifyMainGroupFn(
        mainGroupJid,
        `[Re-notification] ${notice}`,
      );
      logger.warn(
        { submissionId: submission.id, taskId: submission.task_id },
        'Re-notified main group about staged memory submission',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Route a completed task's result to its requester (main group or parent specialist). */
async function _routeResult(
  task: SpecialistTask,
  resultText: string,
): Promise<void> {
  if (task.requester_group) {
    // Main group requested this task — deliver result as a notification
    await _deps.notifyMainGroupFn(
      task.requester_group,
      `Specialist ${task.specialist_type} completed:\n\n${resultText}`,
    );
  } else if (task.requester_task_id) {
    // Parent specialist requested this task — resume it with the result
    const parentTask = getSpecialistTask(task.requester_task_id);
    if (!parentTask) {
      logger.error(
        { taskId: task.id, parentTaskId: task.requester_task_id },
        'Parent task not found for result routing',
      );
      return;
    }

    // Add last-turn parent notice if this was the last permitted dispatch of this type
    const completedTask = getSpecialistTask(task.id)!;
    await _deps.startContainerFn(parentTask, completedTask);
  }
}

/** Route a failed task's failure to its requester. */
async function _routeFailure(
  task: SpecialistTask,
  kind: FailureKind,
  detail: string,
): Promise<void> {
  if (task.requester_group) {
    await _deps.notifyMainGroupFn(
      task.requester_group,
      `Specialist ${task.specialist_type} failed (${kind}): ${detail}`,
    );
  } else if (task.requester_task_id) {
    const parentTask = getSpecialistTask(task.requester_task_id);
    if (!parentTask) {
      logger.error(
        { taskId: task.id, parentTaskId: task.requester_task_id },
        'Parent task not found for failure routing',
      );
      return;
    }
    const failedTask = getSpecialistTask(task.id)!;
    await _deps.startContainerFn(parentTask, failedTask);
  }
}

/** Build the memory submission notice posted to the main group. */
function _memorySubmissionNotice(
  task: SpecialistTask,
  topic: string,
  stagingPath: string,
): string {
  return (
    `Specialist ${task.specialist_type} (depth=${task.depth}) submitted raw memory: ` +
    `'${topic}' at ${stagingPath}`
  );
}

// Re-export getSameTypeDispatchCount for use by IPC layer (Phase 6)
export { getSameTypeDispatchCount } from './db.js';
