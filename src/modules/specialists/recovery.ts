/**
 * Specialist recovery sweep — called from host-sweep.ts once per tick.
 *
 * Handles five lifecycle events (see specialists.allium "three failure paths"):
 *
 *   1. Global timeout: any live task older than max_task_duration → failed
 *      with kind=timeout. Cancels any pending child subtree.
 *
 *   2. Sub-task await timeout: a task in awaiting_sub_task whose pending
 *      child's dispatched_at is older than max_sub_task_await — restart the
 *      parent (SubTaskAwaitTimedOut) or fail it (SubTaskAwaitExhausted).
 *      The parent's container is intentionally stopped in awaiting_sub_task
 *      (it exited after calling dispatch_sub_task), so crash detection does
 *      not apply here; this is a distinct detection path.
 *
 *   3. Container started: a queued or awaiting_restart task whose container
 *      became alive → advance to running (SpecialistTaskStarted).
 *
 *   4. Crash detection: a task in running or queued whose container is stopped
 *      — increment restart_attempt_count, transition to awaiting_restart
 *      (SpecialistContainerCrashed) or failed with kind=host_restart
 *      (SpecialistRestartExhausted). When crashing from awaiting_sub_task the
 *      child subtree is cancelled (ChildSubtreeCancelledOnParentCrash).
 *      Note: awaiting_sub_task is excluded — the parent container is expected
 *      to be stopped in that state; path 2 above handles liveness detection.
 *
 *   5. Re-spawn: a task in awaiting_restart with no running container → re-wake.
 */
import { log } from '../../log.js';
import { isContainerRunning } from '../../container-runner.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { getLiveTasksWithSessions, getTask, updateTaskStatus } from './db.js';
import { routeResult } from './routing.js';
import type { SpecialistTask } from './types.js';

const LIVE_STATUSES = new Set(['queued', 'running', 'awaiting_sub_task', 'awaiting_restart']);

/**
 * Recursively cancel a sub-task subtree rooted at taskId.
 * Implements SubtreeCancellationApplied from specialists.allium.
 */
async function cancelSubtree(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  if (task.status === 'completed' || task.status === 'failed') return;

  const ts = new Date().toISOString();
  updateTaskStatus(task.id, 'failed', {
    failure_kind: 'execution_error',
    failure_detail: 'cancelled: ancestor specialist container crashed',
    closed_at: ts,
    pending_sub_task_id: null,
  });
  log.info('specialists: sub-task cancelled due to ancestor crash', { taskId: task.id });

  if (task.pending_sub_task_id) {
    await cancelSubtree(task.pending_sub_task_id);
  }
}

export async function sweepSpecialistTasks(): Promise<void> {
  let tasks: Array<SpecialistTask & { session_id: string; container_status: string }>;
  try {
    tasks = getLiveTasksWithSessions();
  } catch (err) {
    // Table may not exist if the migration hasn't run yet (e.g. fresh install
    // where the module hasn't been wired in yet).
    log.debug('specialists: sweep skipped (table not ready)', { err });
    return;
  }

  const now = Date.now();

  for (const task of tasks) {
    try {
      await sweepTask(task, now);
    } catch (err) {
      log.error('specialists: sweep error for task', { taskId: task.id, err });
    }
  }
}

async function sweepTask(
  task: SpecialistTask & { session_id: string; container_status: string },
  now: number,
): Promise<void> {
  // Re-fetch to skip tasks already transitioned by an earlier step in this tick
  // (e.g. a sibling's processing called cancelSubtree on this task).
  const fresh = getTask(task.id);
  if (!fresh || fresh.status === 'completed' || fresh.status === 'failed') return;

  // ── 1. Global timeout ─────────────────────────────────────────────────────
  const age = now - Date.parse(task.dispatched_at);
  if (age > SPECIALISTS_CONFIG.maxTaskDurationMs && LIVE_STATUSES.has(task.status)) {
    const ts = new Date().toISOString();
    const pendingChildId = task.pending_sub_task_id;
    updateTaskStatus(task.id, 'failed', {
      failure_kind: 'timeout',
      failure_detail: 'task exceeded maximum duration',
      closed_at: ts,
      pending_sub_task_id: null,
    });
    // ChildSubtreeCancelledOnSubTaskAwaitExhausted: cancel any pending child
    // when failing with kind=timeout (fires for both SpecialistTaskTimedOut
    // and SubTaskAwaitExhausted paths per specialists.allium:1607-1613).
    if (pendingChildId) await cancelSubtree(pendingChildId);
    const failed = {
      ...task,
      status: 'failed' as const,
      failure_kind: 'timeout',
      failure_detail: 'task exceeded maximum duration',
      closed_at: ts,
      pending_sub_task_id: null,
    };
    await routeResult(failed);
    log.warn('specialists: task timed out', { taskId: task.id });
    return;
  }

  // ── 2. Sub-task await timeout ─────────────────────────────────────────────
  // The parent is in awaiting_sub_task and its container is intentionally
  // stopped (it exited after calling dispatch_sub_task). Detection uses the
  // child's dispatched_at, not the parent's container status.
  // spec: sub_task_await_overdue = status = awaiting_sub_task
  //         and pending_sub_task != null
  //         and (pending_sub_task.dispatched_at + max_sub_task_await) <= now
  if (task.status === 'awaiting_sub_task' && task.pending_sub_task_id) {
    const child = getTask(task.pending_sub_task_id);
    if (child) {
      const childAge = now - Date.parse(child.dispatched_at);
      if (childAge > SPECIALISTS_CONFIG.maxSubTaskAwaitMs) {
        const pendingChildId = task.pending_sub_task_id;
        if (task.restart_attempt_count < SPECIALISTS_CONFIG.maxRestartRetries) {
          // SubTaskAwaitTimedOut: retries remain → awaiting_restart.
          // ChildSubtreeCancelledOnParentCrash fires on awaiting_restart transitions.
          updateTaskStatus(task.id, 'awaiting_restart', {
            restart_attempt_count: task.restart_attempt_count + 1,
            pending_sub_task_id: null,
          });
          await cancelSubtree(pendingChildId);
          log.warn('specialists: sub-task await timed out, queuing parent for restart', {
            taskId: task.id,
            pendingChildId,
            attempt: task.restart_attempt_count + 1,
          });
        } else {
          // SubTaskAwaitExhausted: retries exhausted → failed with timeout.
          const ts = new Date().toISOString();
          updateTaskStatus(task.id, 'failed', {
            failure_kind: 'timeout',
            failure_detail: 'sub-task did not complete within the await window after exhausting restart retries',
            closed_at: ts,
            pending_sub_task_id: null,
          });
          // ChildSubtreeCancelledOnSubTaskAwaitExhausted
          await cancelSubtree(pendingChildId);
          const failed = {
            ...task,
            status: 'failed' as const,
            failure_kind: 'timeout',
            failure_detail: 'sub-task did not complete within the await window after exhausting restart retries',
            closed_at: ts,
            pending_sub_task_id: null,
          };
          await routeResult(failed);
          log.warn('specialists: sub-task await exhausted — parent task failed', {
            taskId: task.id,
            pendingChildId,
          });
        }
        return;
      }
    }
  }

  const containerAlive = isContainerRunning(task.session_id);

  // ── 3. Container started → advance to running ─────────────────────────────
  // A queued or awaiting_restart task whose container became alive transitions
  // to running. This covers both first starts (queued → running) and restarts
  // (awaiting_restart → running), matching SpecialistTaskStarted in the spec.
  if ((task.status === 'queued' || task.status === 'awaiting_restart') && containerAlive) {
    updateTaskStatus(task.id, 'running');
    log.info('specialists: task advanced to running', { taskId: task.id, from: task.status });
    return;
  }

  // ── 4. Crash detection ───────────────────────────────────────────────────
  // Only running tasks are crash-detected. queued tasks are intentionally
  // excluded: a queued task with no container is either (a) legitimately
  // waiting in wakeOrQueue's in-memory concurrency queue for a slot to open,
  // or (b) freshly dispatched before the container has started. Treating
  // either as a crash would burn through restart_attempt_count while the
  // task is merely waiting, exhausting retries before the container ever
  // gets a chance to start. This matches v1 behaviour (specialists.ts only
  // crash-detected running tasks). awaiting_sub_task is also excluded: the
  // parent container exits cleanly after dispatch_sub_task; path 2 handles
  // liveness detection for that state.
  if (!containerAlive && task.status === 'running') {
    const newRetryCount = task.restart_attempt_count + 1;
    const pendingChildId = task.pending_sub_task_id;

    if (newRetryCount > SPECIALISTS_CONFIG.maxRestartRetries) {
      // SpecialistRestartExhausted: retries exhausted → fail with host_restart.
      const ts = new Date().toISOString();
      updateTaskStatus(task.id, 'failed', {
        failure_kind: 'host_restart',
        failure_detail: `container crashed after ${task.restart_attempt_count} restart attempts`,
        closed_at: ts,
        restart_attempt_count: newRetryCount,
        pending_sub_task_id: null,
      });
      // ChildSubtreeCancelledOnRestartExhausted
      if (pendingChildId) await cancelSubtree(pendingChildId);
      const failed = {
        ...task,
        status: 'failed' as const,
        failure_kind: 'host_restart',
        failure_detail: `container crashed after ${task.restart_attempt_count} restart attempts`,
        closed_at: ts,
        pending_sub_task_id: null,
      };
      await routeResult(failed);
      log.warn('specialists: task failed — restart limit exceeded', {
        taskId: task.id,
        retries: task.restart_attempt_count,
      });
    } else {
      // SpecialistContainerCrashed: retries remain → awaiting_restart.
      updateTaskStatus(task.id, 'awaiting_restart', {
        restart_attempt_count: newRetryCount,
        pending_sub_task_id: null,
      });
      // ChildSubtreeCancelledOnParentCrash
      if (pendingChildId) await cancelSubtree(pendingChildId);
      log.info('specialists: task crash detected, queued for restart', {
        taskId: task.id,
        attempt: newRetryCount,
        maxRetries: SPECIALISTS_CONFIG.maxRestartRetries,
      });
    }
    return;
  }

  // ── 5. awaiting_restart → re-spawn (or exhaust) ──────────────────────────
  // A task in awaiting_restart with no container running needs to be re-spawned.
  // Increment restart_attempt_count on each re-wake attempt so that a container
  // that crashes immediately (before the sweep can observe it in running state)
  // still makes progress toward the retry limit and doesn't loop forever.
  if (task.status === 'awaiting_restart' && !containerAlive) {
    const newRetryCount = task.restart_attempt_count + 1;

    if (newRetryCount > SPECIALISTS_CONFIG.maxRestartRetries) {
      const ts = new Date().toISOString();
      updateTaskStatus(task.id, 'failed', {
        failure_kind: 'host_restart',
        failure_detail: `container failed to start after ${task.restart_attempt_count} restart attempts`,
        closed_at: ts,
        restart_attempt_count: newRetryCount,
        pending_sub_task_id: null,
      });
      if (task.pending_sub_task_id) await cancelSubtree(task.pending_sub_task_id);
      const failed = {
        ...task,
        status: 'failed' as const,
        failure_kind: 'host_restart',
        failure_detail: `container failed to start after ${task.restart_attempt_count} restart attempts`,
        closed_at: ts,
        pending_sub_task_id: null,
      };
      await routeResult(failed);
      log.warn('specialists: task failed — restart limit exceeded', {
        taskId: task.id,
        retries: task.restart_attempt_count,
      });
      return;
    }

    updateTaskStatus(task.id, 'awaiting_restart', { restart_attempt_count: newRetryCount });

    const { findSessionByAgentGroupAndThread } = await import('./session-helpers.js');
    const { wakeOrQueue } = await import('../../container-runner.js');
    const { getSession } = await import('../../db/sessions.js');
    const { writeSessionMessage } = await import('../../session-manager.js');
    const session = findSessionByAgentGroupAndThread(task.specialist_group_id, task.id);
    if (session) {
      const fresh = getSession(session.id);
      if (fresh) {
        // Write a fresh trigger so the restarted container has a message to process.
        // The original trigger was already acked; the container needs a new one.
        writeSessionMessage(fresh.agent_group_id, fresh.id, {
          id: `restart-${task.id}-${newRetryCount}`,
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
        await wakeOrQueue(fresh).catch((err) =>
          log.error('specialists: failed to wake container for restart', { err, taskId: task.id }),
        );
        log.info('specialists: re-waking container for awaiting_restart task', {
          taskId: task.id,
          attempt: newRetryCount,
          maxRetries: SPECIALISTS_CONFIG.maxRestartRetries,
        });
      }
    }
  }
}
