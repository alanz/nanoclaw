import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  generateUserProfile,
  ProfileGenerationRunner,
} from './session-warm-start.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  deleteSession,
  getAllTasks,
  getChatActivity,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  clearSession: (groupFolder: string) => void;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  getWarmStartPrompt?: (group: RegisteredGroup) => Promise<string>;
}

/**
 * Handle a session_reset task: archive the current session and clear it
 * without spawning an agent container. Skips if the chat has been active
 * within min_idle_minutes (default 60).
 */
async function runSessionReset(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  startTime: number,
): Promise<void> {
  const minIdle = task.min_idle_minutes ?? 60;

  const lastActivity = getChatActivity(task.chat_jid);
  if (lastActivity) {
    const idleMs = Date.now() - new Date(lastActivity).getTime();
    const idleMinutes = idleMs / 60000;
    if (idleMinutes < minIdle) {
      const msg = `Skipped: group active ${Math.round(idleMinutes)}m ago (threshold: ${minIdle}m)`;
      logger.info(
        { taskId: task.id, idleMinutes: Math.round(idleMinutes), minIdle },
        'session_reset skipped: group not idle enough',
      );
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'skipped',
        result: msg,
        error: null,
      });
      updateTaskAfterRun(task.id, computeNextRun(task), msg);
      return;
    }
  }

  const sessions = deps.getSessions();
  const sessionId = sessions[task.group_folder];
  if (!sessionId) {
    const msg = 'Skipped: no active session';
    logger.info({ taskId: task.id }, 'session_reset: no active session');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'skipped',
      result: msg,
      error: null,
    });
    updateTaskAfterRun(task.id, computeNextRun(task), msg);
    return;
  }

  // Write IPC task file — same format as session-commands.ts / writeIpcTask in index.ts
  const ipcTaskDir = path.join(DATA_DIR, 'ipc', task.group_folder, 'tasks');
  fs.mkdirSync(ipcTaskDir, { recursive: true });
  fs.writeFileSync(
    path.join(ipcTaskDir, `${Date.now()}-session-archive.json`),
    JSON.stringify({
      type: 'request_session_archive',
      jid: task.chat_jid,
      sessionId,
      groupFolder: task.group_folder,
    }),
  );

  // Clear the in-memory session so the next message starts a fresh context
  deps.clearSession(task.group_folder);

  const msg = `Session ${sessionId.slice(0, 8)} archived`;
  logger.info(
    { taskId: task.id, sessionId },
    'session_reset: IPC task written, session cleared',
  );
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    status: 'success',
    result: msg,
    error: null,
  });
  updateTaskAfterRun(task.id, computeNextRun(task), msg);
}

/**
 * Handle a user_profile task: spawn an isolated agent on the main group to
 * synthesise memory/USER.md. The profile update is communicated back through
 * the file watcher (onProfileFileUpdated in index.ts), not via chat.
 */
async function runUserProfileGeneration(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  startTime: number,
): Promise<void> {
  const groups = deps.registeredGroups();
  const group = Object.values(groups).find((g) => g.isMain === true);

  if (!group) {
    const error = 'No main group found for user profile generation';
    logger.error({ taskId: task.id }, error);
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    updateTaskAfterRun(task.id, computeNextRun(task), `Error: ${error}`);
    return;
  }

  const runner: ProfileGenerationRunner = { runContainerAgent };

  let error: string | null = null;
  try {
    await generateUserProfile(group, task.chat_jid, ASSISTANT_NAME, runner);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startTime;
  const result = error ? null : 'Profile generation dispatched';
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });
  updateTaskAfterRun(
    task.id,
    computeNextRun(task),
    error ? `Error: ${error}` : result!,
  );
}

export async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();

  if ((task.task_type ?? 'prompt') === 'session_reset') {
    await runSessionReset(task, deps, startTime);
    return;
  }

  if (task.task_type === 'user_profile') {
    await runUserProfileGeneration(task, deps, startTime);
    return;
  }

  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  let totalTokens: number | undefined;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Prepend warm-start context to the task prompt (Phase 1-3 context injection).
  let taskPrompt = task.prompt;
  if (deps.getWarmStartPrompt) {
    try {
      const warmPrefix = await deps.getWarmStartPrompt(group);
      if (warmPrefix) {
        taskPrompt = `${warmPrefix}\n\n${taskPrompt}`;
      }
    } catch (err) {
      logger.warn(
        { err, taskId: task.id },
        'Warm-start context assembly failed for task',
      );
    }
  }

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: taskPrompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        dispatchDepth: task.dispatch_depth ?? 0,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.totalTokens != null) {
          totalTokens = streamedOutput.totalTokens;
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(
            task.chat_jid,
            streamedOutput.result,
            'Scheduler',
          );
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
    total_tokens: totalTokens,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
