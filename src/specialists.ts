/**
 * Specialist task orchestration — implements specialists.allium and delegation-policy.allium.
 *
 * All functions are async-safe and operate against the SQLite DB via db.ts helpers.
 * Container lifecycle is injected via initSpecialists() so this module is testable
 * without a running container runtime.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  SPECIALIST_TEMPLATE_DIR,
  SPECIALISTS_CONFIG,
} from './config.js';
import {
  checkDelegationPolicy,
  DelegationDecision,
} from './delegation-policy.js';
import {
  createRawMemorySubmission,
  createSpecialistSession,
  createSpecialistTask,
  getLiveSpecialistTasks,
  getRawMemorySubmission,
  getRawMemorySubmissionsByStatus,
  getSameTypeDispatchCount,
  getSpecialistSession,
  getSpecialistTask,
  getSpecialistTasksByStatus,
  markRawMemorySubmissionOverdueAlerted,
  updateRawMemorySubmission,
  updateSpecialistSession,
  updateSpecialistTask,
} from './db.js';
import { resolveSpecialistGroupFolderPath } from './group-folder.js';
import { expireTransfersForTask } from './ipc-transfer.js';
import { logger } from './logger.js';
import { getSpecialistType } from './specialist-types.js';
import { FailureKind, SpecialistTask, SpecialistType } from './types.js';

// ---------------------------------------------------------------------------
// Group folder management
// ---------------------------------------------------------------------------

/**
 * Ensure the specialist group folder exists for the given type.
 * If it does not exist, create it by copying the specialist-template CLAUDE.md
 * with the type name and description substituted in.
 * Idempotent — safe to call on every dispatch.
 */
export function ensureSpecialistGroupFolder(type: SpecialistType): void {
  const folderPath = resolveSpecialistGroupFolderPath(type.name);
  if (fs.existsSync(folderPath)) return;

  fs.mkdirSync(folderPath, { recursive: true });

  const templatePath = path.join(SPECIALIST_TEMPLATE_DIR, 'CLAUDE.md');
  if (fs.existsSync(templatePath)) {
    const template = fs.readFileSync(templatePath, 'utf8');
    const content = template
      .replace('{{TYPE_NAME}}', type.name)
      .replace('{{TYPE_DESCRIPTION}}', type.description);
    fs.writeFileSync(path.join(folderPath, 'CLAUDE.md'), content, 'utf8');
  } else {
    logger.warn(
      { templatePath, typeName: type.name },
      'Specialist template CLAUDE.md not found — created empty group folder',
    );
  }

  logger.info(
    { typeName: type.name, folderPath },
    'Created specialist group folder',
  );
}

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

  ensureSpecialistGroupFolder(type);

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

  ensureSpecialistGroupFolder(targetType);

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

  ensureSpecialistGroupFolder(targetType);

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

  expireTransfersForTask(taskId);
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

  expireTransfersForTask(taskId);
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
    overdue_alerted_at: null,
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

  type RetryEntry = { type: string; attempt: number; max: number };
  const retrying: RetryEntry[] = [];
  const exhausted: { type: string }[] = [];

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

      const attempt = task.restart_attempt_count + 1;
      logger.warn(
        {
          taskId: task.id,
          attempt,
          max: SPECIALISTS_CONFIG.maxRestartRetries,
        },
        'Specialist task scheduled for retry after host restart',
      );

      retrying.push({
        type: task.specialist_type,
        attempt,
        max: SPECIALISTS_CONFIG.maxRestartRetries,
      });
      const updated = getSpecialistTask(task.id)!;
      await _deps.startContainerFn(updated, null);
    } else {
      // Retries exhausted — fail and propagate
      await failSpecialistTask(
        task.id,
        'host_restart',
        'Container lost on host restart; retries exhausted',
      );
      exhausted.push({ type: task.specialist_type });
    }
  }

  // Post a single consolidated summary covering both retrying and exhausted tasks
  if ((retrying.length > 0 || exhausted.length > 0) && mainGroupJid) {
    const lines: string[] = ['Host restarted.'];

    if (retrying.length > 0) {
      lines.push(
        `${retrying.length} specialist task(s) are being retried silently:`,
      );
      for (const e of retrying) {
        lines.push(`  ${e.type} (attempt ${e.attempt} of ${e.max})`);
      }
      lines.push('Delegation chains will resume when tasks complete.');
    }

    if (exhausted.length > 0) {
      lines.push(
        `${exhausted.length} specialist task(s) failed — retries exhausted:`,
      );
      for (const e of exhausted) {
        lines.push(`  ${e.type}`);
      }
    }

    const summary = lines.join('\n');
    logger.warn({ retrying, exhausted }, summary);
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
      `Specialist ${task.specialist_type} completed:\n\n${resultText}\n\n---\nPlease reply to the user with a brief summary of what you found and any notes or files you created.`,
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

/**
 * Parse JSONL session log content and produce a short post-mortem summary.
 * Exported for testing.
 */
export function _parseSessionPostMortem(
  sessionId: string,
  jsonlContent: string,
): string {
  const lines = jsonlContent.trim().split('\n').filter(Boolean);

  let lastToolName: string | null = null;
  let lastToolInput: string | null = null;
  let lastToolResultSnippet: string | null = null;
  let apiError: string | null = null;
  let lastAssistantText: string | null = null;
  let messageCount = 0;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === 'assistant') {
      messageCount++;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      if (entry.isApiErrorMessage) {
        const content = msg.content as
          | Array<{ type: string; text?: string }>
          | undefined;
        const text = content?.find((c) => c.type === 'text')?.text ?? '';
        apiError = text.replace(/\s+/g, ' ').slice(0, 200);
        continue;
      }

      const content = msg.content as
        | Array<{
            type: string;
            text?: string;
            name?: string;
            input?: unknown;
          }>
        | undefined;
      if (!content) continue;

      for (const block of content) {
        if (block.type === 'tool_use') {
          lastToolName = block.name ?? null;
          const inputStr = JSON.stringify(block.input ?? {});
          lastToolInput =
            inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr;
          lastToolResultSnippet = null; // reset; will be filled by next tool_result
        }
        if (block.type === 'text' && block.text) {
          const t = block.text.replace(/\s+/g, ' ').trim();
          if (t) lastAssistantText = t.slice(0, 150);
        }
      }
    }

    if (entry.type === 'user') {
      const toolResult = entry.toolUseResult;
      if (toolResult && typeof toolResult === 'object') {
        const r = toolResult as Record<string, unknown>;
        // Prefer HTTP status summary for web fetches, otherwise stdout snippet
        if (typeof r.code === 'number') {
          lastToolResultSnippet =
            `${r.code} ${r.codeText ?? ''} (${r.bytes ?? '?'} bytes)`.trim();
        } else if (typeof r.stdout === 'string') {
          const s = r.stdout.replace(/\s+/g, ' ').trim();
          lastToolResultSnippet = s.slice(0, 100) || null;
        } else if (Array.isArray(toolResult)) {
          const text =
            (toolResult as Array<{ type: string; text?: string }>).find(
              (c) => c.type === 'text',
            )?.text ?? '';
          const s = text.replace(/\s+/g, ' ').trim();
          lastToolResultSnippet = s.slice(0, 100) || null;
        }
      }
    }
  }

  const parts: string[] = [
    `Post-mortem (session ${sessionId.slice(0, 8)}…, ${messageCount} turns):`,
  ];
  if (lastToolName) {
    parts.push(`• Last tool: ${lastToolName}(${lastToolInput ?? ''})`);
    if (lastToolResultSnippet) parts.push(`  → ${lastToolResultSnippet}`);
  }
  if (apiError) parts.push(`• API error: ${apiError}`);
  if (!lastToolName && lastAssistantText)
    parts.push(`• Last response: ${lastAssistantText}`);

  return parts.join('\n');
}

/**
 * Read the JSONL session log for a specialist task and produce a short
 * post-mortem summary describing what the agent was doing when it failed.
 */
function _buildPostMortem(taskId: string, sessionId: string): string {
  const jsonlPath = path.join(
    DATA_DIR,
    'sessions',
    `spec-${taskId}`,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );

  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return `(session log unavailable)`;
  }

  return _parseSessionPostMortem(sessionId, content);
}

/** Route a failed task's failure to its requester. */
async function _routeFailure(
  task: SpecialistTask,
  kind: FailureKind,
  detail: string,
): Promise<void> {
  const session = getSpecialistSession(task.id);
  const postMortem = session
    ? _buildPostMortem(task.id, session.session_id)
    : null;
  const failureMessage =
    `Specialist ${task.specialist_type} failed (${kind}): ${detail}` +
    (postMortem ? `\n\n${postMortem}` : '');

  if (task.requester_group) {
    await _deps.notifyMainGroupFn(task.requester_group, failureMessage);
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

// ---------------------------------------------------------------------------
// 5k — Overall task timeout poller (SpecialistTaskOverallTimeout)
// ---------------------------------------------------------------------------

/**
 * Check all live specialist tasks and fail any that have exceeded max_task_duration.
 * Safe to call multiple times; skips tasks already in a terminal state.
 */
export async function checkOverdueSpecialistTasks(): Promise<void> {
  const liveTasks = getLiveSpecialistTasks();
  const now = Date.now();
  for (const task of liveTasks) {
    const durationMs = now - new Date(task.delegated_at).getTime();
    if (durationMs > SPECIALISTS_CONFIG.maxTaskDurationMs) {
      logger.warn(
        {
          taskId: task.id,
          durationMs,
          maxMs: SPECIALISTS_CONFIG.maxTaskDurationMs,
        },
        'Specialist task exceeded overall duration limit — failing',
      );
      await failSpecialistTask(
        task.id,
        'timeout',
        'Overall task duration exceeded',
      );
    }
  }
}

let _overduePollerRunning = false;

/**
 * Start the periodic poller that enforces SpecialistTaskOverallTimeout.
 * Runs every SCHEDULER_POLL_INTERVAL ms. Idempotent.
 */
export function startOverdueSpecialistPoller(pollIntervalMs: number): void {
  if (_overduePollerRunning) return;
  _overduePollerRunning = true;

  const loop = async () => {
    try {
      await checkOverdueSpecialistTasks();
    } catch (err) {
      logger.error({ err }, 'Error in overdue specialist poller');
    }
    setTimeout(loop, pollIntervalMs);
  };

  loop();
}

/** @internal — for tests only. */
export function _resetOverduePollerForTest(): void {
  _overduePollerRunning = false;
}

// ---------------------------------------------------------------------------
// 5l — Staged submission overdue alert (StagedSubmissionOverdue)
// ---------------------------------------------------------------------------

/**
 * Alert the main group for any staged memory submissions that have exceeded
 * max_staging_duration without being accepted or rejected.
 * Fires once per submission (tracked via overdue_alerted_at).
 */
export async function checkStagedSubmissionsOverdue(
  mainGroupJid: string,
): Promise<void> {
  const staged = getRawMemorySubmissionsByStatus('staged');
  const now = Date.now();
  for (const submission of staged) {
    if (submission.overdue_alerted_at) continue;
    const age = now - new Date(submission.submitted_at).getTime();
    if (age > SPECIALISTS_CONFIG.maxStagingDurationMs) {
      const msg =
        `Staged memory submission overdue: '${submission.topic}' ` +
        `(id: ${submission.id}, submitted ${new Date(submission.submitted_at).toISOString()}, ` +
        `staging path: ${submission.staging_path}). ` +
        `It has been waiting longer than ${SPECIALISTS_CONFIG.maxStagingDurationMs / (60 * 60 * 1000)}h without being accepted.`;
      logger.warn(
        { submissionId: submission.id, ageMs: age },
        'Staged memory submission overdue',
      );
      await _deps.notifyMainGroupFn(mainGroupJid, msg);
      markRawMemorySubmissionOverdueAlerted(
        submission.id,
        new Date().toISOString(),
      );
    }
  }
}

let _stagingOverduePollerRunning = false;

/**
 * Start the periodic poller that enforces StagedSubmissionOverdue.
 * Runs every pollIntervalMs. Idempotent.
 */
export function startStagedSubmissionOverduePoller(
  mainGroupJid: string,
  pollIntervalMs: number,
): void {
  if (_stagingOverduePollerRunning) return;
  _stagingOverduePollerRunning = true;

  const loop = async () => {
    try {
      await checkStagedSubmissionsOverdue(mainGroupJid);
    } catch (err) {
      logger.error({ err }, 'Error in staged submission overdue poller');
    }
    setTimeout(loop, pollIntervalMs);
  };

  loop();
}

/** @internal — for tests only. */
export function _resetStagingOverduePollerForTest(): void {
  _stagingOverduePollerRunning = false;
}

// Re-export getSameTypeDispatchCount for use by IPC layer (Phase 6)
export { getSameTypeDispatchCount } from './db.js';
