import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAX_DISPATCH_DEPTH,
  MEMORY_SEARCH_ENABLED,
  TIMEZONE,
} from './config.js';
import { getOrCreateMemoryManager } from './memory/manager.js';
import {
  AvailableGroup,
  runContainerAgent,
  ContainerInput,
} from './container-runner.js';
import { stopContainer } from './container-runtime.js';
import { snapshotGroup, gradeAssertions } from './eval-utils.js';
import {
  createRssFeed,
  createTask,
  getRssFeedById,
  updateRssFeed,
  getTaskById,
  getSpecialistTask,
  queryTranscript,
  storeMessage,
  updateContainerTransfer,
  updateTask,
  updateTransferFile,
} from './db.js';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import { takeFileOwnership } from './ipc-transfer.js';
import { logger } from './logger.js';
import {
  deliverResult,
  dispatchSpecialist,
  dispatchSubTask,
  handleMemoryQuery,
  reportSession,
  submitRawMemory,
} from './specialists.js';
import { RegisteredGroup } from './types.js';

type RemoteEnvResult = { ok: true; url: string } | { ok: false; error: string };

/** Compute the next ISO timestamp for an RSS feed schedule starting from now. Returns null on error. */
function computeRssNextCheck(
  scheduleType: 'cron' | 'interval',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      return (
        interval.next().toISOString() ??
        new Date(Date.now() + 86400000).toISOString()
      );
    } catch {
      return null;
    }
  } else {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  sendFile: (
    jid: string,
    filePath: string,
    caption?: string,
    sender?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  setGroupTrusted: (jid: string, trusted: boolean) => void;
  syncGroups: (force: boolean) => Promise<void>;
  startRemoteControl: (chatJid: string) => Promise<RemoteEnvResult>;
  stopRemoteControl: (chatJid: string) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  setPendingDispatchDepth: (jid: string, depth: number) => void;
  /** Called when the main group schedules a task targeting a sub-group (cycle opened). */
  onCycleDelegated?: (subGroupFolder: string, taskId: string) => void;
  /** Called when a sub-group delivers a result back to main (cycle closed). */
  onCycleDelivered?: (subGroupFolder: string) => void;
  setReaction?: (jid: string, emoji: string) => Promise<void>;
  /** Called when a background container (e.g. throwaway) spawns, so it can be
   *  registered with the queue for web UI visibility. */
  onProcess?: (
    jid: string,
    proc: import('child_process').ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  /** Called when a background container exits, to clear the queue registration. */
  onProcessExit?: (jid: string) => void;
}

let ipcWatcherRunning = false;

/** Follow the requester chain for a specialist task and return the root requester group JID, or null. */
function findRequesterGroupJid(taskId: string): string | null {
  const task = getSpecialistTask(taskId);
  if (!task) return null;
  if (task.requester_group) return task.requester_group;
  if (task.requester_task_id)
    return findRequesterGroupJid(task.requester_task_id);
  return null;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message') {
                await processMessageIpc(data, sourceGroup, isMain, deps);
              } else if (
                data.type === 'file' &&
                data.chatJid &&
                data.ipcRelativePath
              ) {
                // Authorization: same as message
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Resolve host path and validate it stays within the IPC dir
                  const groupIpcDir = resolveGroupIpcPath(sourceGroup);
                  const hostPath = path.resolve(
                    groupIpcDir,
                    data.ipcRelativePath,
                  );
                  const rel = path.relative(groupIpcDir, hostPath);
                  if (rel.startsWith('..') || path.isAbsolute(rel)) {
                    logger.warn(
                      { ipcRelativePath: data.ipcRelativePath, sourceGroup },
                      'IPC file path escapes IPC directory, blocked',
                    );
                  } else {
                    await deps.sendFile(
                      data.chatJid,
                      hostPath,
                      data.caption,
                      data.sender,
                    );
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC file sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file send attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processMessageIpc(
  data: { type: string; chatJid?: string; text?: string; sender?: string },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  if (data.type === 'message' && data.chatJid && data.text) {
    const targetGroup = registeredGroups[data.chatJid];
    if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
      await deps.sendMessage(data.chatJid, data.text, data.sender);
      logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
    } else if (data.chatJid.startsWith('specialist:')) {
      const taskId = data.chatJid.slice('specialist:'.length);
      if (sourceGroup === `spec-${taskId}`) {
        const requesterJid = findRequesterGroupJid(taskId);
        if (requesterJid) {
          await deps.sendMessage(requesterJid, data.text, data.sender);
          logger.info(
            { chatJid: data.chatJid, sourceGroup, requesterJid },
            'Specialist progress message forwarded to requester',
          );
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Specialist progress message: no requester group found',
          );
        }
      } else {
        logger.warn(
          { chatJid: data.chatJid, sourceGroup },
          'Unauthorized specialist message attempt blocked',
        );
      }
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC message attempt blocked',
      );
    }
  }
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group / set_group_trusted
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    trusted?: boolean;
    // For subscribe_rss / unsubscribe_rss
    feedId?: string;
    feedUrl?: string;
    feedScheduleType?: 'interval' | 'cron';
    feedScheduleValue?: string;
    feedInterest?: string;
    // For deliver_result / schedule_task depth tracking
    dispatchDepth?: number;
    text?: string;
    // For run_skill_eval
    skillName?: string;
    caseId?: string;
    withSkill?: boolean;
    assertions?: string[];
    timeoutMs?: number;
    // For query_transcript
    requestId?: string;
    from?: string;
    to?: string;
    limit?: number;
    afterCursor?: string;
    includeBotMessages?: boolean;
    // For set_reaction
    emoji?: string;
    // For spawn_throwaway_session / request_session_archive
    jsonlPath?: string;
    // For memory_search / memory_get / memory_list
    query?: string;
    path?: string;
    min_score?: number;
    include_content?: boolean;
    path_prefix?: string;
    source?: string;
    order_by?: string;
    parse_frontmatter?: boolean;
    // For specialist IPC commands (dispatch_specialist, query_memory_specialist,
    // deliver_specialist_result, report_specialist_session, submit_raw_memory)
    parentTaskId?: string;
    parentTypeName?: string;
    targetTypeName?: string;
    sessionId?: string;
    resultText?: string;
    filePaths?: string; // JSON-encoded string[] from deliver_specialist_result
    commitToMemory?: boolean;
    filePath?: string; // single path from send_file
    caption?: string;
    invocationId?: string;
    _dataDir?: string; // override DATA_DIR in tests
    _groupsDir?: string; // override GROUPS_DIR in tests
    sourceGroup?: string;
    topic?: string;
    stagingPath?: string;
    // For dispatch_specialist_task (main group dispatches a top-level specialist)
    typeName?: string;
    // For schedule_task task_type extension
    task_type?: string;
    min_idle_minutes?: number;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid &&
        (data.task_type === 'session_reset' ||
          data.task_type === 'user_profile' ||
          data.prompt)
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt || '',
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          dispatch_depth: data.dispatchDepth ?? 0,
          task_type:
            data.task_type === 'session_reset'
              ? 'session_reset'
              : data.task_type === 'user_profile'
                ? 'user_profile'
                : 'prompt',
          min_idle_minutes:
            typeof data.min_idle_minutes === 'number'
              ? data.min_idle_minutes
              : null,
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        // Track orchestration cycle if main is delegating to a different (sub) group
        if (isMain && targetFolder !== sourceGroup) {
          deps.onCycleDelegated?.(targetFolder, taskId);
        }
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          if (task.status === 'cancelled') {
            logger.warn(
              { taskId: data.taskId, sourceGroup },
              'Cannot resume a cancelled task',
            );
          } else {
            updateTask(data.taskId, { status: 'active' });
            logger.info(
              { taskId: data.taskId, sourceGroup },
              'Task resumed via IPC',
            );
            deps.onTasksChanged();
          }
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'cancelled', next_run: null });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger ?? true,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'set_group_trusted':
      // Only main group can change trust status
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_group_trusted attempt blocked',
        );
        break;
      }
      if (data.jid && typeof data.trusted === 'boolean') {
        const targetGroup = registeredGroups[data.jid];
        if (!targetGroup) {
          logger.warn(
            { jid: data.jid },
            'set_group_trusted: group not registered',
          );
          break;
        }
        deps.setGroupTrusted(data.jid, data.trusted);
        logger.info(
          { jid: data.jid, trusted: data.trusted },
          'Group trusted status updated via IPC',
        );
      } else {
        logger.warn(
          { data },
          'Invalid set_group_trusted request - missing fields',
        );
      }
      break;

    case 'remote_control':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized remote_control attempt blocked',
        );
        break;
      }
      if (data.chatJid) {
        const result: RemoteEnvResult = await deps.startRemoteControl(
          data.chatJid,
        );
        const text = result.ok
          ? `Remote control ready: ${result.url}`
          : `Remote control failed: ${result.error}`;
        await deps.sendMessage(data.chatJid, text);
        logger.info(
          { chatJid: data.chatJid, ok: result.ok },
          'remote_control handled',
        );
      }
      break;

    case 'remote_control_stop':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized remote_control_stop attempt blocked',
        );
        break;
      }
      if (data.chatJid) {
        await deps.stopRemoteControl(data.chatJid);
      }
      break;

    case 'subscribe_rss': {
      if (
        !data.feedId ||
        !data.feedUrl ||
        !data.feedScheduleType ||
        !data.feedScheduleValue
      ) {
        logger.warn({ data }, 'Invalid subscribe_rss request — missing fields');
        break;
      }

      // target_jid is optional; when omitted, default to the caller's own group JID
      const targetJid =
        data.targetJid ??
        Object.entries(registeredGroups).find(
          ([, g]) => g.folder === sourceGroup,
        )?.[0];

      if (!targetJid) {
        logger.warn(
          { sourceGroup },
          'subscribe_rss: could not resolve target JID for source group',
        );
        break;
      }

      const targetGroupEntry = registeredGroups[targetJid];
      if (!targetGroupEntry) {
        logger.warn(
          { targetJid },
          'subscribe_rss: target group not registered',
        );
        break;
      }

      const targetFolder = targetGroupEntry.folder;
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder },
          'Unauthorized subscribe_rss attempt blocked',
        );
        break;
      }

      const nextCheck = computeRssNextCheck(
        data.feedScheduleType,
        data.feedScheduleValue,
      );
      if (!nextCheck) {
        logger.warn(
          { value: data.feedScheduleValue, type: data.feedScheduleType },
          'subscribe_rss: invalid schedule',
        );
        break;
      }

      createRssFeed({
        id: data.feedId,
        group_folder: targetFolder,
        chat_jid: targetJid,
        url: data.feedUrl,
        title: null,
        schedule_type: data.feedScheduleType,
        schedule_value: data.feedScheduleValue,
        status: 'active',
        next_check: nextCheck,
        seen_guids: '[]',
        interest: data.feedInterest ?? null,
        created_at: new Date().toISOString(),
      });
      logger.info(
        { feedId: data.feedId, url: data.feedUrl, targetFolder },
        'RSS feed subscribed via IPC',
      );
      break;
    }

    case 'unsubscribe_rss': {
      if (!data.feedId) {
        logger.warn(
          { data },
          'Invalid unsubscribe_rss request — missing feedId',
        );
        break;
      }
      const feedToDelete = getRssFeedById(data.feedId);
      if (!feedToDelete) {
        logger.warn(
          { feedId: data.feedId, sourceGroup },
          'unsubscribe_rss — feed not found',
        );
        break;
      }
      if (!isMain && feedToDelete.group_folder !== sourceGroup) {
        logger.warn(
          {
            feedId: data.feedId,
            feedGroup: feedToDelete.group_folder,
            sourceGroup,
          },
          'Unauthorized unsubscribe_rss attempt blocked',
        );
        break;
      }
      updateRssFeed(data.feedId, { status: 'cancelled', next_check: null });
      logger.info(
        { feedId: data.feedId, sourceGroup },
        'RSS feed cancelled via IPC',
      );
      break;
    }

    case 'pause_rss': {
      if (!data.feedId) {
        logger.warn({ data }, 'Invalid pause_rss request — missing feedId');
        break;
      }
      const feedToPause = getRssFeedById(data.feedId);
      if (!feedToPause) {
        logger.warn(
          { feedId: data.feedId, sourceGroup },
          'pause_rss — feed not found',
        );
        break;
      }
      if (!isMain && feedToPause.group_folder !== sourceGroup) {
        logger.warn(
          {
            feedId: data.feedId,
            feedGroup: feedToPause.group_folder,
            sourceGroup,
          },
          'Unauthorized pause_rss attempt blocked',
        );
        break;
      }
      if (feedToPause.status !== 'active') {
        logger.warn(
          { feedId: data.feedId, status: feedToPause.status },
          'pause_rss — feed is not active',
        );
        break;
      }
      updateRssFeed(data.feedId, { status: 'paused', next_check: null });
      logger.info(
        { feedId: data.feedId, sourceGroup },
        'RSS feed paused via IPC',
      );
      break;
    }

    case 'resume_rss': {
      if (!data.feedId) {
        logger.warn({ data }, 'Invalid resume_rss request — missing feedId');
        break;
      }
      const feedToResume = getRssFeedById(data.feedId);
      if (!feedToResume) {
        logger.warn(
          { feedId: data.feedId, sourceGroup },
          'resume_rss — feed not found',
        );
        break;
      }
      if (!isMain && feedToResume.group_folder !== sourceGroup) {
        logger.warn(
          {
            feedId: data.feedId,
            feedGroup: feedToResume.group_folder,
            sourceGroup,
          },
          'Unauthorized resume_rss attempt blocked',
        );
        break;
      }
      if (feedToResume.status === 'cancelled') {
        logger.warn(
          { feedId: data.feedId },
          'resume_rss — cannot resume a cancelled feed',
        );
        break;
      }
      const nextCheck = computeRssNextCheck(
        feedToResume.schedule_type,
        feedToResume.schedule_value,
      );
      if (!nextCheck) {
        logger.warn(
          { feedId: data.feedId },
          'resume_rss — feed has invalid schedule, cannot compute next_check',
        );
        break;
      }
      updateRssFeed(data.feedId, { status: 'active', next_check: nextCheck });
      logger.info(
        { feedId: data.feedId, sourceGroup, nextCheck },
        'RSS feed resumed via IPC',
      );
      break;
    }

    case 'query_transcript': {
      if (!data.requestId || !data.chatJid) {
        logger.warn(
          { data },
          'Invalid query_transcript request — missing requestId or chatJid',
        );
        break;
      }
      const targetJid = data.chatJid;
      const targetGroup = registeredGroups[targetJid];
      if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
        logger.warn(
          { sourceGroup, targetJid },
          'Unauthorized query_transcript attempt blocked',
        );
        break;
      }
      const result = queryTranscript({
        chatJid: targetJid,
        from: data.from,
        to: data.to,
        limit: typeof data.limit === 'number' ? data.limit : 50,
        afterCursor: data.afterCursor,
        includeBotMessages: data.includeBotMessages === true,
      });
      const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responseDir, { recursive: true });
      fs.writeFileSync(
        path.join(responseDir, `${data.requestId}.json`),
        JSON.stringify(result),
      );
      logger.info(
        {
          requestId: data.requestId,
          chatJid: targetJid,
          count: result.messages.length,
          has_more: result.has_more,
        },
        'Transcript query fulfilled',
      );
      break;
    }

    case 'memory_search': {
      if (!data.requestId || !data.query) {
        logger.warn(
          { data },
          'Invalid memory_search request — missing requestId or query',
        );
        break;
      }
      const group = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      let memSearchResponse: unknown;
      if (!MEMORY_SEARCH_ENABLED || !group) {
        memSearchResponse = { error: 'Memory search not available' };
      } else {
        try {
          const mgr = await getOrCreateMemoryManager(group.folder);
          if (!mgr) {
            memSearchResponse = { error: 'Memory search not available' };
          } else {
            const results = await mgr.search(data.query, {
              maxResults:
                typeof data.limit === 'number' ? data.limit : undefined,
              minScore:
                typeof data.min_score === 'number' ? data.min_score : undefined,
              pathPrefix: data.path_prefix,
              source: data.source,
              includeContent: data.include_content,
            });
            const total = mgr.totalIndexed();
            memSearchResponse = {
              results,
              total_indexed: total,
              query_used: data.query,
            };
          }
        } catch (err) {
          logger.warn({ err }, 'memory_search IPC handler error');
          memSearchResponse = { error: String(err) };
        }
      }
      const memSearchDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(memSearchDir, { recursive: true });
      fs.writeFileSync(
        path.join(memSearchDir, `${data.requestId}.json`),
        JSON.stringify(memSearchResponse),
      );
      logger.info(
        { requestId: data.requestId, sourceGroup },
        'memory_search fulfilled',
      );
      break;
    }

    case 'memory_get': {
      if (!data.requestId || !data.path) {
        logger.warn(
          { data },
          'Invalid memory_get request — missing requestId or path',
        );
        break;
      }
      const group = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      let memGetResponse: unknown;
      if (!MEMORY_SEARCH_ENABLED || !group) {
        memGetResponse = { error: 'Memory not available' };
      } else {
        try {
          const mgr = await getOrCreateMemoryManager(group.folder);
          if (!mgr) {
            memGetResponse = { error: 'Memory not available' };
          } else {
            memGetResponse = await mgr.getFileContent(data.path, {
              parseFrontmatter: data.parse_frontmatter !== false,
            });
          }
        } catch (err) {
          logger.warn({ err }, 'memory_get IPC handler error');
          memGetResponse = { error: String(err) };
        }
      }
      const memGetDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(memGetDir, { recursive: true });
      fs.writeFileSync(
        path.join(memGetDir, `${data.requestId}.json`),
        JSON.stringify(memGetResponse),
      );
      logger.info(
        { requestId: data.requestId, sourceGroup },
        'memory_get fulfilled',
      );
      break;
    }

    case 'memory_list': {
      if (!data.requestId) {
        logger.warn(
          { data },
          'Invalid memory_list request — missing requestId',
        );
        break;
      }
      const group = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      let memListResponse: unknown;
      if (!MEMORY_SEARCH_ENABLED || !group) {
        memListResponse = { error: 'Memory not available' };
      } else {
        try {
          const mgr = await getOrCreateMemoryManager(group.folder);
          if (!mgr) {
            memListResponse = { error: 'Memory not available' };
          } else {
            memListResponse = mgr.listFiles({
              pathPrefix: data.path_prefix,
              source: data.source,
              limit: typeof data.limit === 'number' ? data.limit : undefined,
              orderBy: data.order_by as 'mtime' | 'path' | 'size' | undefined,
              parseFrontmatter: data.parse_frontmatter,
            });
          }
        } catch (err) {
          logger.warn({ err }, 'memory_list IPC handler error');
          memListResponse = { error: String(err) };
        }
      }
      const memListDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(memListDir, { recursive: true });
      fs.writeFileSync(
        path.join(memListDir, `${data.requestId}.json`),
        JSON.stringify(memListResponse),
      );
      logger.info(
        { requestId: data.requestId, sourceGroup },
        'memory_list fulfilled',
      );
      break;
    }

    case 'deliver_result': {
      // Only sub-groups may deliver results — main cannot inject into itself
      if (isMain) {
        logger.warn(
          { sourceGroup },
          'deliver_result blocked: main group cannot use this',
        );
        break;
      }

      if (!data.text) {
        logger.warn({ data }, 'deliver_result: missing text');
        break;
      }

      const depth = data.dispatchDepth ?? 0;
      if (depth >= MAX_DISPATCH_DEPTH) {
        logger.warn(
          { sourceGroup, depth, MAX_DISPATCH_DEPTH },
          'deliver_result blocked: max dispatch depth reached',
        );
        break;
      }

      // Find the main group JID — only main groups receive injected deliveries
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      if (!mainEntry) {
        logger.warn(
          { sourceGroup },
          'deliver_result: no main group registered',
        );
        break;
      }
      const [mainJid] = mainEntry;

      storeMessage({
        id: `delivery-${sourceGroup}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: mainJid,
        sender: `system:${sourceGroup}`,
        sender_name: sourceGroup,
        content: data.text,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });

      deps.setPendingDispatchDepth(mainJid, depth + 1);
      deps.onCycleDelivered?.(sourceGroup);

      logger.info(
        { sourceGroup, mainJid, depth },
        'deliver_result injected into main group',
      );
      break;
    }

    case 'run_skill_eval': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'run_skill_eval blocked: not main group');
        break;
      }
      if (
        !data.requestId ||
        !data.skillName ||
        data.prompt === undefined ||
        data.withSkill === undefined
      ) {
        logger.warn(
          { data },
          'Invalid run_skill_eval request — missing required fields',
        );
        break;
      }
      const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responsesDir, { recursive: true });
      const responsePath = path.join(responsesDir, `${data.requestId}.json`);

      const mainGroup = Object.values(registeredGroups).find((g) => g.isMain);
      if (!mainGroup) {
        logger.warn({ sourceGroup }, 'run_skill_eval: main group not found');
        fs.writeFileSync(
          responsePath,
          JSON.stringify({
            status: 'error',
            caseId: data.caseId,
            error: 'Main group not found',
          }),
        );
        break;
      }

      // Fire and forget — container runs can take minutes; don't block the IPC polling loop
      void (async () => {
        const { evalGroup, cleanup } = snapshotGroup(mainGroup);
        try {
          const input: ContainerInput = {
            prompt: data.prompt!,
            groupFolder: evalGroup.folder,
            chatJid: 'eval-internal',
            isMain: false,
            evalSkipSkills: data.withSkill ? [] : [data.skillName!],
          };

          const start = Date.now();
          const output = await runContainerAgent(evalGroup, input, () => {});
          const durationMs = Date.now() - start;

          const assertionResults = await gradeAssertions(
            output.result ?? output.error ?? '',
            '', // no output file collection in the IPC path
            data.assertions ?? [],
          );

          fs.writeFileSync(
            responsePath,
            JSON.stringify(
              {
                status: 'success',
                caseId: data.caseId,
                withSkill: data.withSkill,
                passed: assertionResults.every((r) => r.passed === true),
                assertionResults,
                output: output.result,
                durationMs,
                totalTokens: output.totalTokens ?? null,
              },
              null,
              2,
            ),
          );

          logger.info(
            { requestId: data.requestId, sourceGroup, durationMs },
            'run_skill_eval completed',
          );
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          fs.writeFileSync(
            responsePath,
            JSON.stringify({ status: 'error', caseId: data.caseId, error }),
          );
          logger.error(
            { requestId: data.requestId, sourceGroup, err },
            'run_skill_eval failed',
          );
        } finally {
          cleanup();
        }
      })();
      break;
    }

    case 'send_file': {
      const {
        filePath,
        invocationId: srcInvocationId,
        chatJid: targetJid,
        caption,
        _dataDir,
      } = data;
      if (!filePath || !srcInvocationId || !targetJid) {
        logger.warn({ data }, 'send_file: missing required fields');
        break;
      }
      const targetGroup = registeredGroups[targetJid];
      if (!isMain && !(targetGroup && targetGroup.folder === sourceGroup)) {
        logger.warn(
          { targetJid, sourceGroup },
          'Unauthorized send_file attempt blocked',
        );
        break;
      }
      try {
        const result = takeFileOwnership({
          invocationId: srcInvocationId,
          filePaths: [filePath],
          message: caption ?? '',
          recipientTaskId: null,
          recipientGroupFolder: null,
          senderGroupFolder: sourceGroup,
          _dataDir,
        });
        if (!result.ok) {
          logger.warn(
            { error: result.error, targetJid, sourceGroup },
            'send_file: file ownership failed',
          );
          break;
        }
        await deps.sendFile(targetJid, result.files[0].host_path, caption);
        updateContainerTransfer(result.transfer.id, {
          status: 'user_delivered',
        });
        updateTransferFile(result.files[0].id, { status: 'expired' });
        logger.info({ targetJid, sourceGroup }, 'IPC file sent');
      } catch (err) {
        logger.error({ targetJid, sourceGroup, err }, 'IPC send_file failed');
      }
      break;
    }

    case 'set_reaction': {
      const { jid, emoji } = data;
      if (jid && emoji && deps.setReaction) {
        const targetGroup = registeredGroups[jid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          await deps.setReaction(jid, emoji);
        } else {
          logger.warn(
            { jid, sourceGroup },
            'Unauthorized set_reaction attempt blocked',
          );
        }
      }
      break;
    }

    // ---------------------------------------------------------------------------
    // Specialist IPC commands — emitted by specialist containers
    // ---------------------------------------------------------------------------

    case 'dispatch_specialist': {
      const {
        parentTaskId,
        parentTypeName,
        targetTypeName,
        prompt,
        sessionId,
      } = data;
      if (
        !parentTaskId ||
        !parentTypeName ||
        !targetTypeName ||
        !prompt ||
        !sessionId
      ) {
        logger.warn({ data }, 'dispatch_specialist: missing required fields');
        break;
      }
      try {
        const result = await dispatchSubTask(
          parentTaskId,
          parentTypeName,
          targetTypeName,
          prompt,
          sessionId,
        );
        if (!result.ok) {
          logger.warn(
            {
              parentTaskId,
              targetTypeName,
              rejectionKind: result.rejection.rejectionKind,
            },
            'dispatch_specialist rejected by delegation policy',
          );
        } else {
          logger.info(
            { parentTaskId, targetTypeName },
            'dispatch_specialist succeeded',
          );
        }
      } catch (err) {
        logger.error(
          { parentTaskId, targetTypeName, err },
          'dispatch_specialist failed',
        );
      }
      break;
    }

    case 'query_memory_specialist': {
      const { taskId, targetTypeName, prompt, sessionId } = data;
      if (!taskId || !targetTypeName || !prompt || !sessionId) {
        logger.warn(
          { data },
          'query_memory_specialist: missing required fields',
        );
        break;
      }
      try {
        await handleMemoryQuery(taskId, targetTypeName, prompt, sessionId);
        logger.info(
          { taskId, targetTypeName },
          'query_memory_specialist dispatched',
        );
      } catch (err) {
        logger.error(
          { taskId, targetTypeName, err },
          'query_memory_specialist failed',
        );
      }
      break;
    }

    case 'deliver_specialist_result': {
      const {
        taskId,
        resultText,
        filePaths,
        commitToMemory,
        invocationId: srcInvocationId,
        _dataDir: dataDir,
        _groupsDir: groupsDir,
      } = data;
      if (!taskId || resultText == null) {
        logger.warn(
          { data },
          'deliver_specialist_result: missing required fields',
        );
        break;
      }
      try {
        let finalResultText: string = resultText;

        // If the container staged files in ipc-out, take ownership before they
        // are cleaned up on container exit.
        const rawFilePaths: unknown = filePaths ? JSON.parse(filePaths) : [];
        const parsedFilePaths = Array.isArray(rawFilePaths)
          ? (rawFilePaths as string[])
          : [];

        if (parsedFilePaths.length > 0 && srcInvocationId) {
          if (commitToMemory) {
            // Commit files directly to the main group's memory/reports/ directory.
            const mainGroup = Object.values(deps.registeredGroups()).find(
              (g) => g.isMain,
            );
            const mainFolder = mainGroup?.folder ?? 'main';
            const reportsDir = path.join(
              groupsDir ?? GROUPS_DIR,
              mainFolder,
              'memory',
              'reports',
            );
            fs.mkdirSync(reportsDir, { recursive: true });
            const committedPaths: string[] = [];
            for (const fp of parsedFilePaths) {
              const fileName = path.basename(fp);
              // Source: ipc-out dir on host (invocation-specific)
              const srcPath = path.join(
                dataDir ?? DATA_DIR,
                'invocations',
                srcInvocationId,
                'ipc-out',
                fileName,
              );
              const destPath = path.join(reportsDir, fileName);
              fs.copyFileSync(srcPath, destPath);
              committedPaths.push(`memory/reports/${fileName}`);
            }
            const fileList = committedPaths
              .map((p) => `- /workspace/group/${p}`)
              .join('\n');
            finalResultText = `${resultText}\n\nResearch report committed to memory:\n${fileList}`;
            logger.info(
              { taskId, committedPaths },
              'Research report committed to memory/reports',
            );
          } else {
            const result = takeFileOwnership({
              invocationId: srcInvocationId,
              filePaths: parsedFilePaths,
              message: resultText,
              recipientTaskId: taskId,
              recipientGroupFolder: null,
              senderGroupFolder: sourceGroup,
            });
            if (result.ok) {
              const fileList = result.files
                .map(
                  (f) =>
                    `- /workspace/ipc-in/${result.transfer.id}/${f.original_name}`,
                )
                .join('\n');
              finalResultText = `${resultText}\n\nFiles from this specialist are available at:\n${fileList}`;
              logger.info(
                {
                  taskId,
                  transferId: result.transfer.id,
                  fileCount: result.files.length,
                },
                'File ownership taken for specialist result',
              );
            } else {
              logger.warn(
                { taskId, error: result.error },
                'File ownership failed for specialist result — delivering without files',
              );
            }
          }
        }

        await deliverResult(taskId, finalResultText);
        logger.info({ taskId }, 'deliver_specialist_result succeeded');
      } catch (err) {
        logger.error({ taskId, err }, 'deliver_specialist_result failed');
      }
      break;
    }

    case 'report_specialist_session': {
      const { taskId, sessionId } = data;
      if (!taskId || !sessionId) {
        logger.warn(
          { data },
          'report_specialist_session: missing required fields',
        );
        break;
      }
      try {
        await reportSession(taskId, sessionId);
        logger.info(
          { taskId, sessionId },
          'report_specialist_session recorded',
        );
      } catch (err) {
        logger.error(
          { taskId, sessionId, err },
          'report_specialist_session failed',
        );
      }
      break;
    }

    case 'submit_raw_memory': {
      const { taskId, topic, stagingPath } = data;
      if (!taskId || !topic || !stagingPath) {
        logger.warn({ data }, 'submit_raw_memory: missing required fields');
        break;
      }
      // Find main group JID — submissions are always routed to the main group
      const mainMemEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      if (!mainMemEntry) {
        logger.warn(
          { sourceGroup },
          'submit_raw_memory: no main group registered',
        );
        break;
      }
      const [mainMemJid] = mainMemEntry;
      // Resolve host path for the staging file; must remain within the IPC directory
      const groupIpcDir = path.join(DATA_DIR, 'ipc', sourceGroup);
      const hostStagingPath = path.resolve(groupIpcDir, stagingPath);
      const rel = path.relative(groupIpcDir, hostStagingPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        logger.warn(
          { stagingPath, sourceGroup },
          'submit_raw_memory: staging path escapes IPC directory, blocked',
        );
        break;
      }
      try {
        await submitRawMemory(taskId, topic, hostStagingPath, mainMemJid);
        logger.info({ taskId, topic }, 'submit_raw_memory succeeded');
      } catch (err) {
        logger.error({ taskId, topic, err }, 'submit_raw_memory failed');
      }
      break;
    }

    case 'dispatch_specialist_task': {
      // Only the main group can dispatch top-level specialists
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'dispatch_specialist_task: blocked — only main group may dispatch',
        );
        break;
      }
      const { typeName, prompt } = data;
      if (!typeName || !prompt) {
        logger.warn(
          { data },
          'dispatch_specialist_task: missing typeName or prompt',
        );
        break;
      }
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      if (!mainEntry) {
        logger.warn('dispatch_specialist_task: no main group registered');
        break;
      }
      const [mainJid] = mainEntry;
      try {
        const task = await dispatchSpecialist(mainJid, typeName, prompt);
        logger.info(
          { taskId: task.id, typeName },
          'dispatch_specialist_task: specialist dispatched',
        );
      } catch (err) {
        logger.error({ typeName, err }, 'dispatch_specialist_task failed');
      }
      break;
    }

    case 'spawn_throwaway_session': {
      // Emitted by the container's PostCompact hook.
      // Fields: jid (chatJid), sessionId, jsonlPath, groupFolder
      const { jid, sessionId, jsonlPath, groupFolder } = data;
      if (!jid || !sessionId || !groupFolder) {
        logger.warn(
          { data },
          'spawn_throwaway_session: missing required fields',
        );
        break;
      }
      const tsGroup = Object.values(registeredGroups).find(
        (g) => g.folder === groupFolder,
      );
      if (!tsGroup) {
        logger.warn(
          { groupFolder },
          'spawn_throwaway_session: group not registered',
        );
        break;
      }
      spawnThrowaway(tsGroup, jid, sessionId, jsonlPath, undefined, deps).catch(
        (err) =>
          logger.error(
            { err, sessionId },
            'Throwaway session failed unexpectedly',
          ),
      );
      break;
    }

    case 'request_session_archive': {
      // Emitted by the host-side /reset handler (written by session-commands.ts via deps.writeIpcTask).
      // Fields: jid (chatJid), sessionId, groupFolder
      const { jid, sessionId, groupFolder } = data;
      if (!jid || !sessionId || !groupFolder) {
        logger.warn(
          { data },
          'request_session_archive: missing required fields',
        );
        break;
      }
      const raGroup = Object.values(registeredGroups).find(
        (g) => g.folder === groupFolder,
      );
      if (!raGroup) {
        logger.warn(
          { groupFolder },
          'request_session_archive: group not registered',
        );
        break;
      }

      // ⏳ signals archiving is in progress (same as PreCompact)
      if (deps.setReaction) await deps.setReaction(jid, '⏳');

      const jsonlPath = getSessionJsonlPath(groupFolder, sessionId);
      const groupDir = resolveGroupFolderPath(groupFolder);
      const conversationsDir = path.join(groupDir, 'conversations');
      const sessionsDir = path.join(groupDir, 'memory', 'sessions');
      const now = new Date();
      const date = now.toISOString().split('T')[0];
      const timestamp = now.toISOString().slice(11, 16).replace(':', '');

      if (!fs.existsSync(jsonlPath)) {
        // ResetJonlMissing: write placeholder archive + placeholder summary
        logger.error(
          { sessionId, jsonlPath },
          'Session JSONL missing at /reset',
        );
        writeArchivePlaceholder(
          conversationsDir,
          sessionId,
          date,
          timestamp,
          'missing',
        );
        writeSummaryPlaceholder(
          sessionsDir,
          sessionId,
          date,
          timestamp,
          'missing',
        );
        if (deps.setReaction) await deps.setReaction(jid, '💭');
        break;
      }

      let messages: SessionParsedMessage[];
      try {
        messages = parseSessionJsonl(fs.readFileSync(jsonlPath, 'utf-8'));
      } catch (err) {
        logger.error(
          { sessionId, jsonlPath, err },
          'Failed to read session JSONL at /reset',
        );
        writeArchivePlaceholder(
          conversationsDir,
          sessionId,
          date,
          timestamp,
          'missing',
        );
        writeSummaryPlaceholder(
          sessionsDir,
          sessionId,
          date,
          timestamp,
          'missing',
        );
        if (deps.setReaction) await deps.setReaction(jid, '💭');
        break;
      }

      if (messages.length === 0) {
        // ResetOnEmptySession: write placeholder archive + placeholder summary
        logger.warn(
          { sessionId, groupFolder },
          'Reset issued on empty session',
        );
        writeArchivePlaceholder(
          conversationsDir,
          sessionId,
          date,
          timestamp,
          'empty',
        );
        writeSummaryPlaceholder(
          sessionsDir,
          sessionId,
          date,
          timestamp,
          'empty',
        );
        if (deps.setReaction) await deps.setReaction(jid, '💭');
        break;
      }

      // ArchiveAndStartThrowawayOnReset: write real archive and spawn throwaway.
      // The archive is written synchronously first; the throwaway reads it instead of
      // the raw JSONL so long sessions don't exceed the throwaway's context window.
      const archiveFilename = `${date}-${timestamp}-reset.md`;
      writeConversationArchive(
        conversationsDir,
        sessionId,
        jsonlPath,
        messages,
        date,
        timestamp,
      );
      spawnThrowaway(
        raGroup,
        jid,
        sessionId,
        jsonlPath,
        archiveFilename,
        deps,
      ).catch((err) =>
        logger.error({ err, sessionId }, 'Throwaway session failed on reset'),
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// ---------------------------------------------------------------------------
// Session archiving helpers
// ---------------------------------------------------------------------------

/** Compute the host-side JSONL path for a session. */
export function getSessionJsonlPath(
  groupFolder: string,
  sessionId: string,
): string {
  return path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

interface SessionParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Parse a JSONL transcript into messages (same logic as container parseTranscript). */
function parseSessionJsonl(content: string): SessionParsedMessage[] {
  const messages: SessionParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = (
          entry.message.content as Array<{ type: string; text?: string }>
        )
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '');
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

/** Write a real conversation archive from parsed messages. */
function writeConversationArchive(
  conversationsDir: string,
  sessionId: string,
  jsonlPath: string,
  messages: SessionParsedMessage[],
  date: string,
  timestamp: string,
): void {
  fs.mkdirSync(conversationsDir, { recursive: true });
  const filename = `${date}-${timestamp}-reset.md`;
  const now = new Date();
  const lines: string[] = [
    '---',
    `session_id: ${sessionId}`,
    `archived_at: ${now.toISOString()}`,
    `source_jsonl: ${jsonlPath}`,
    'is_placeholder: false',
    '---',
    '',
    '# Conversation',
    '',
    `Archived: ${now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`,
    '',
    '---',
    '',
  ];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  fs.writeFileSync(path.join(conversationsDir, filename), lines.join('\n'));
  logger.info({ sessionId, filename }, 'Conversation archive written on reset');
}

/** Write a placeholder archive (missing or empty JSONL). */
function writeArchivePlaceholder(
  conversationsDir: string,
  sessionId: string,
  date: string,
  timestamp: string,
  suffix: 'missing' | 'empty',
): void {
  fs.mkdirSync(conversationsDir, { recursive: true });
  const filename = `${date}-${timestamp}-${suffix}.md`;
  const now = new Date();
  const content = [
    '---',
    `session_id: ${sessionId}`,
    `archived_at: ${now.toISOString()}`,
    'is_placeholder: true',
    '---',
    '',
    `# ${suffix === 'missing' ? 'Missing JSONL' : 'Empty Session'}`,
    '',
    suffix === 'missing'
      ? `Session JSONL was not found at reset time.`
      : `No messages were recorded in this session.`,
  ].join('\n');
  fs.writeFileSync(path.join(conversationsDir, filename), content);
  logger.info(
    { sessionId, filename },
    `Archive placeholder written (${suffix})`,
  );
}

/** Write a placeholder session summary. */
function writeSummaryPlaceholder(
  sessionsDir: string,
  sessionId: string,
  date: string,
  timestamp: string,
  suffix: 'missing' | 'empty' | 'failed',
): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filename = `${date}-${timestamp}-${suffix}.md`;
  const now = new Date();
  const content = [
    '---',
    `session_id: ${sessionId}`,
    `created_at: ${now.toISOString()}`,
    'is_placeholder: true',
    '---',
    '',
    `# Summary Unavailable (${suffix})`,
    '',
    suffix === 'missing'
      ? 'Session JSONL was not found — no summary could be generated.'
      : suffix === 'empty'
        ? 'Session had no messages — no summary was needed.'
        : 'Throwaway summarisation failed. Retry by running the throwaway manually.',
  ].join('\n');
  fs.writeFileSync(path.join(sessionsDir, filename), content);
  logger.info(
    { sessionId, filename },
    `Summary placeholder written (${suffix})`,
  );
}

/** Parse session_id and is_placeholder from a markdown file's YAML frontmatter. */
/**
 * Spawn a throwaway agent container to produce a SessionSummary from a JSONL transcript.
 * Non-blocking: caller should .catch() the returned promise.
 */
export async function spawnThrowaway(
  group: RegisteredGroup,
  chatJid: string,
  sessionId: string,
  jsonlPath: string | undefined,
  archiveFilename: string | undefined,
  deps: IpcDeps,
): Promise<void> {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().slice(11, 16).replace(':', '');
  const summaryFilename = `${date}-${timeStr}.md`;
  const groupDir = resolveGroupFolderPath(group.folder);
  const summaryFullPath = path.join(
    groupDir,
    'memory',
    'sessions',
    summaryFilename,
  );

  // Prefer the conversation archive (clean markdown, already written by the host) over
  // the raw JSONL. The JSONL can be hundreds of KB of complex SDK JSON that exceeds the
  // throwaway's effective context window for long sessions.
  const transcriptSource = archiveFilename
    ? `Read the conversation archive at: /workspace/group/conversations/${archiveFilename}`
    : jsonlPath
      ? `Read the session transcript at: /home/node/.claude/projects/-workspace-group/${path.basename(jsonlPath)}`
      : null;

  const prompt =
    `You are writing a session summary. Do nothing except what is described here.\n\n` +
    (transcriptSource
      ? `${transcriptSource}\n`
      : `The session transcript path is unknown. Write a placeholder summary.\n`) +
    `Write a structured summary to: /workspace/group/memory/sessions/${summaryFilename}\n\n` +
    `The file must start with this YAML frontmatter:\n` +
    `---\nsession_id: ${sessionId}\ncreated_at: ${now.toISOString()}\nis_placeholder: false\n---\n\n` +
    `After the frontmatter, include: key decisions made, important facts learned, ` +
    `open questions, and tasks completed or started. Write in markdown. ` +
    `After writing the file, stop immediately without doing anything else.`;

  const containerInput: ContainerInput = {
    prompt,
    sessionId: undefined, // fresh session — no resume
    groupFolder: group.folder,
    chatJid,
    isMain: false,
    isThrowaway: true, // prevents PreCompact/PostCompact hooks from spawning more throwaways
  };

  let throwawayContainerName: string | null = null;
  let summaryPoller: ReturnType<typeof setInterval> | null = null;

  // Kill the container as soon as the summary file appears — Claude often
  // continues generating verification text after writing the file, which
  // would otherwise block the host event loop until the 30-min hard timeout.
  const startSummaryPoller = () => {
    summaryPoller = setInterval(() => {
      if (fs.existsSync(summaryFullPath) && throwawayContainerName) {
        clearInterval(summaryPoller!);
        summaryPoller = null;
        logger.info(
          { sessionId, summaryFilename },
          'Summary file detected — stopping throwaway container early',
        );
        try {
          stopContainer(throwawayContainerName);
        } catch {
          // container may have already exited
        }
      }
    }, 5_000);
  };

  try {
    await runContainerAgent(group, containerInput, (proc, name) => {
      throwawayContainerName = name;
      deps.onProcess?.(chatJid, proc, name, group.folder);
      startSummaryPoller();
    });
  } catch (err) {
    logger.debug(
      { sessionId, err },
      'Throwaway container exited (expected on early stop)',
    );
  } finally {
    if (summaryPoller) {
      clearInterval(summaryPoller);
      summaryPoller = null;
    }
    deps.onProcessExit?.(chatJid);
  }

  const summaryExists = fs.existsSync(summaryFullPath);
  if (summaryExists) {
    // ThrowawaySessionSucceeded (container may have been stopped early)
    logger.info({ sessionId, summaryFilename }, 'Throwaway session succeeded');
  } else {
    // ThrowawaySessionFailed
    logger.error({ sessionId, summaryExists }, 'Throwaway session failed');
    const sessionsDir = path.join(groupDir, 'memory', 'sessions');
    writeSummaryPlaceholder(sessionsDir, sessionId, date, timeStr, 'failed');
  }

  // ✅ = summary written; 💭 = failed (session still needs summarising)
  const reaction = summaryExists ? '✅' : '💭';
  if (deps.setReaction) await deps.setReaction(chatJid, reaction);
}
