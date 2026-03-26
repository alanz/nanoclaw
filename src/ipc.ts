import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MEMORY_SEARCH_ENABLED,
  TIMEZONE,
} from './config.js';
import { getOrCreateMemoryManager } from './memory/manager.js';
import { AvailableGroup } from './container-runner.js';
import {
  createRssFeed,
  createTask,
  deleteRssFeed,
  deleteTask,
  getTaskById,
  queryTranscript,
  updateTask,
} from './db.js';
import { isValidGroupFolder, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

type RemoteEnvResult = { ok: true; url: string } | { ok: false; error: string };

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
}

let ipcWatcherRunning = false;

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
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text, data.sender);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
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
    // For query_transcript
    requestId?: string;
    from?: string;
    to?: string;
    limit?: number;
    afterCursor?: string;
    // For memory_search / memory_get / memory_list
    query?: string;
    path?: string;
    min_score?: number;
    include_content?: boolean;
    path_prefix?: string;
    source?: string;
    order_by?: string;
    parse_frontmatter?: boolean;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
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
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
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
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
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
          deleteTask(data.taskId);
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

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
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
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
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
        !data.feedScheduleValue ||
        !data.targetJid
      ) {
        logger.warn({ data }, 'Invalid subscribe_rss request — missing fields');
        break;
      }

      const targetJid = data.targetJid;
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

      // Compute first next_check
      let nextCheck: string;
      if (data.feedScheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(data.feedScheduleValue, {
            tz: TIMEZONE,
          });
          nextCheck =
            interval.next().toISOString() ??
            new Date(Date.now() + 86400000).toISOString();
        } catch {
          logger.warn(
            { value: data.feedScheduleValue },
            'subscribe_rss: invalid cron',
          );
          break;
        }
      } else {
        const ms = parseInt(data.feedScheduleValue, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn(
            { value: data.feedScheduleValue },
            'subscribe_rss: invalid interval',
          );
          break;
        }
        nextCheck = new Date(Date.now() + ms).toISOString();
      }

      createRssFeed({
        id: data.feedId,
        group_folder: targetFolder,
        chat_jid: targetJid,
        url: data.feedUrl,
        title: null,
        schedule_type: data.feedScheduleType,
        schedule_value: data.feedScheduleValue,
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

    case 'unsubscribe_rss':
      if (!data.feedId) {
        logger.warn(
          { data },
          'Invalid unsubscribe_rss request — missing feedId',
        );
        break;
      }
      deleteRssFeed(data.feedId);
      logger.info(
        { feedId: data.feedId, sourceGroup },
        'RSS feed unsubscribed via IPC',
      );
      break;

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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
