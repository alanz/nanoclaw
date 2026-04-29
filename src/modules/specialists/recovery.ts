/**
 * Specialist recovery sweep — called from host-sweep.ts once per tick.
 *
 * Handles three lifecycle events the host must advance for specialist tasks:
 *
 *   1. queued → running: the task's container has started processing its
 *      trigger message (container_status went to 'running' or 'idle').
 *
 *   2. Crash detection: a task in running / awaiting_sub_task / queued
 *      whose session container is 'stopped' — increment restart_attempt_count,
 *      transition to awaiting_restart (if retries remain) or failed with
 *      kind=host_restart.
 *
 *   3. Timeout: any live task whose dispatched_at is older than
 *      max_task_duration → failed with kind=timeout.
 */
import { log } from '../../log.js';
import { isContainerRunning } from '../../container-runner.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { getLiveTasksWithSessions, updateTaskStatus } from './db.js';
import { routeResult } from './routing.js';
import type { SpecialistTask } from './types.js';

const LIVE_STATUSES = new Set(['queued', 'running', 'awaiting_sub_task', 'awaiting_restart']);

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
  // ── 1. Timeout ────────────────────────────────────────────────────────────
  const age = now - Date.parse(task.dispatched_at);
  if (age > SPECIALISTS_CONFIG.maxTaskDurationMs && LIVE_STATUSES.has(task.status)) {
    const ts = new Date().toISOString();
    updateTaskStatus(task.id, 'failed', {
      failure_kind: 'timeout',
      failure_detail: 'task exceeded maximum duration',
      closed_at: ts,
    });
    const failed = {
      ...task,
      status: 'failed' as const,
      failure_kind: 'timeout',
      failure_detail: 'task exceeded maximum duration',
      closed_at: ts,
    };
    await routeResult(failed);
    log.warn('specialists: task timed out', { taskId: task.id });
    return;
  }

  const containerAlive = isContainerRunning(task.session_id);

  // ── 2. queued → running ───────────────────────────────────────────────────
  // When a specialist container starts processing, the session's
  // container_status moves to 'running' or 'idle'. Advance the task status.
  if (task.status === 'queued' && containerAlive) {
    updateTaskStatus(task.id, 'running');
    log.info('specialists: task started (queued → running)', { taskId: task.id });
    return;
  }

  // ── 3. Crash detection ───────────────────────────────────────────────────
  // A task in running / awaiting_sub_task / queued whose container is stopped
  // indicates a crash (or clean exit without delivering a result — also
  // treated as a crash for recovery purposes).
  if (
    !containerAlive &&
    (task.status === 'running' || task.status === 'awaiting_sub_task' || task.status === 'queued')
  ) {
    const newRetryCount = task.restart_attempt_count + 1;
    if (newRetryCount > SPECIALISTS_CONFIG.maxRestartRetries) {
      const ts = new Date().toISOString();
      updateTaskStatus(task.id, 'failed', {
        failure_kind: 'host_restart',
        failure_detail: `container crashed after ${task.restart_attempt_count} restart attempts`,
        closed_at: ts,
        restart_attempt_count: newRetryCount,
      });
      const failed = {
        ...task,
        status: 'failed' as const,
        failure_kind: 'host_restart',
        failure_detail: `container crashed after ${task.restart_attempt_count} restart attempts`,
        closed_at: new Date().toISOString(),
      };
      await routeResult(failed);
      log.warn('specialists: task failed — restart limit exceeded', {
        taskId: task.id,
        retries: task.restart_attempt_count,
      });
    } else {
      updateTaskStatus(task.id, 'awaiting_restart', {
        restart_attempt_count: newRetryCount,
      });
      log.info('specialists: task crash detected, queued for restart', {
        taskId: task.id,
        attempt: newRetryCount,
        maxRetries: SPECIALISTS_CONFIG.maxRestartRetries,
      });
    }
    return;
  }

  // ── 4. awaiting_restart → re-spawn ────────────────────────────────────────
  // A task in awaiting_restart with no container running needs to be
  // re-spawned. The session already exists; writing to its inbound DB and
  // waking the container is sufficient.
  if (task.status === 'awaiting_restart' && !containerAlive) {
    const { findSessionByAgentGroupAndThread } = await import('./session-helpers.js');
    const { wakeContainer } = await import('../../container-runner.js');
    const { getSession } = await import('../../db/sessions.js');
    const session = findSessionByAgentGroupAndThread(task.specialist_group_id, task.id);
    if (session) {
      const fresh = getSession(session.id);
      if (fresh) {
        await wakeContainer(fresh).catch((err) =>
          log.error('specialists: failed to wake container for restart', { err, taskId: task.id }),
        );
        log.info('specialists: re-waking container for awaiting_restart task', { taskId: task.id });
      }
    }
  }
}
