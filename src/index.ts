import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  SPECIALIST_CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DEFAULT_TRIGGER,
  CYCLE_TIMEOUT,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  MEMORY_SEARCH_ENABLED,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  SPECIALISTS_CONFIG,
  STORE_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
  WEB_UI_BASE_URL,
  WEB_UI_PORT,
  ZOTERO_GROUP_FOLDER,
} from './config.js';
import './channels/index.js';
import { makeSpecialistJid } from './channels/null-channel.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeNanoclawMetadata,
  writeRssFeedsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  ensureContainerRuntimeRunning,
  isContainerRunning,
  killContainer,
  listOrphanedContainers,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllRssFeeds,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSpecialistSession,
  getSpecialistTask,
  initDatabase,
  setRegisteredGroup,
  setPendingDispatchDepthDb,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateSpecialistTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  resolveGroupFolderPath,
  resolveSpecialistGroupFolderPath,
} from './group-folder.js';
import { startIpcWatcher, getSessionJsonlPath, spawnThrowaway } from './ipc.js';
import { placeFilesForInvocation } from './ipc-transfer.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  routeOutbound,
} from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startRssMonitorLoop } from './rss-monitor.js';
import {
  failSpecialistTask,
  handleNanoclawStarted,
  initSpecialists,
  startOverdueSpecialistPoller,
  startStagedSubmissionOverduePoller,
} from './specialists.js';
import { getSpecialistType, initSpecialistTypes } from './specialist-types.js';
import { startZoteroMonitorLoop } from './zotero-monitor.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startWebUi } from './web-ui.js';
import {
  closeAllMemoryManagers,
  getOrCreateMemoryManager,
} from './memory/manager.js';
import { startCredentialProxy } from './credential-proxy.js';
import { PROXY_BIND_HOST } from './container-runtime.js';
import {
  Channel,
  NewMessage,
  RegisteredGroup,
  SpecialistTask,
} from './types.js';
import { logger } from './logger.js';
import {
  buildWarmStartPrompt,
  loadUserProfile,
  onProfileBecomesStale,
  onProfileFileUpdated,
  saveUserProfile,
  type UserProfile,
} from './session-warm-start.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let warmStartProfile: UserProfile = { status: 'absent' };
// pendingDispatchDepth is now persisted on registered_groups.pending_dispatch_depth.
// The in-memory registeredGroups map is kept in sync so reads are cheap.

// Active orchestration cycles: sub-group folder → {taskId, delegatedAt}.
// Set when main schedules a task for a sub-group; cleared on deliver_result or timeout.
const pendingCycles: Record<string, { taskId: string; delegatedAt: number }> =
  {};

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  if (group.isMain) queue.mainGroupJid = jid;

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;
  const isTrustedGroup = group.trustedGroup === true;
  const requiresTrigger =
    !isMainGroup && !isTrustedGroup && group.requiresTrigger !== false;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    isTrustedGroup,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      resetPrompt: (() => {
        try {
          return (
            fs
              .readFileSync(
                path.join(GROUPS_DIR, group.folder, 'reset-prompt.md'),
                'utf8',
              )
              .trim() || undefined
          );
        } catch {
          return undefined;
        }
      })(),
      clearSession: () => {
        delete sessions[group.folder];
        deleteSession(group.folder);
      },
      sessionId: sessions[group.folder],
      formatMessages,
      chatJid,
      groupFolder: group.folder,
      writeIpcTask: (task) => {
        const ipcTaskDir = path.join(DATA_DIR, 'ipc', group.folder, 'tasks');
        fs.mkdirSync(ipcTaskDir, { recursive: true });
        fs.writeFileSync(
          path.join(ipcTaskDir, `${Date.now()}-session-archive.json`),
          JSON.stringify(task),
        );
      },
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = requiresTrigger;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (requiresTrigger) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  // Track the message ID of the in-progress placeholder (for channels that
  // support sendMessageAndGetId + editMessage, e.g. DeltaChat).
  let progressMsgId: string | null = null;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Progress update — send a placeholder on first update, edit in place thereafter.
    if (result.progress && channel.sendMessageAndGetId && channel.editMessage) {
      const progressText = `⏳ ${result.progress}`;
      if (progressMsgId === null) {
        progressMsgId = await channel.sendMessageAndGetId(
          chatJid,
          progressText,
        );
      } else {
        await channel.editMessage(chatJid, progressMsgId, progressText);
      }
    }

    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        // If we sent a progress placeholder, edit it with the final result instead
        // of sending a new message so the conversation stays clean.
        if (progressMsgId !== null && channel.editMessage) {
          await channel.editMessage(chatJid, progressMsgId, text);
          progressMsgId = null;
        } else {
          await channel.sendMessage(chatJid, text);
        }
        storeMessage({
          id: `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          chat_jid: chatJid,
          sender: ASSISTANT_NAME,
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    // Progress-only outputs are not completions — skip idle/typing signals.
    if (result.status === 'success' && !result.progress) {
      queue.notifyIdle(chatJid);
      // Send ✅ here — runAgent only resolves when the container exits (idle timeout),
      // not when the agent finishes its turn. status === 'success' is the real signal.
      await channel.setTyping?.(chatJid, false);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
  let promptToSend = prompt;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Write RSS feeds snapshot for the container to read via list_rss_feeds
  const rssFeeds = getAllRssFeeds();
  writeRssFeedsSnapshot(group.folder, isMain, rssFeeds);

  // Write host metadata (web UI base URL etc.) for the container to read
  writeNanoclawMetadata(group.folder, WEB_UI_BASE_URL);

  // Wrap onOutput to track session ID from streamed results.
  // Only persist newSessionId on success — error outputs can carry the old
  // broken session ID, and persisting it would re-seed the bad session.
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && output.status === 'success') {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  const dispatchDepth = registeredGroups[chatJid]?.pendingDispatchDepth ?? 0;
  if (registeredGroups[chatJid]?.pendingDispatchDepth != null) {
    registeredGroups[chatJid] = {
      ...registeredGroups[chatJid],
      pendingDispatchDepth: undefined,
    };
    setPendingDispatchDepthDb(chatJid, null);
  }

  // Check and apply profile staleness before each spawn.
  const now = new Date();
  const staleness = onProfileBecomesStale(warmStartProfile, now);
  if (staleness) {
    warmStartProfile = staleness;
    saveUserProfile(warmStartProfile);
  }

  // Assemble warm-start context and prepend to the prompt.
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  const mainGroup = mainEntry?.[1];
  if (mainGroup) {
    const mainGroupDir = path.join(GROUPS_DIR, mainGroup.folder);
    const memMgr = MEMORY_SEARCH_ENABLED
      ? await getOrCreateMemoryManager(mainGroup.folder).catch(() => null)
      : null;
    try {
      const warmPrefix = await buildWarmStartPrompt(
        mainGroup,
        mainGroupDir,
        warmStartProfile,
        memMgr,
      );
      if (warmPrefix) {
        promptToSend = `${warmPrefix}\n\n${promptToSend}`;
      }
    } catch (err) {
      logger.warn({ err }, 'Warm-start context assembly failed');
    }
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: promptToSend,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        dispatchDepth,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          for (const msg of groupMessages) {
            logger.info(
              `New message from ${chatJid} (${group.name}): [${msg.sender_name}] ${msg.content.slice(0, 80)}`,
            );
          }

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const isTrustedGroup = group.trustedGroup === true;
          const requiresTrigger =
            !isMainGroup && !isTrustedGroup && group.requiresTrigger !== false;

          // --- /esc interrupt interception (message loop) ---
          // /esc <context> interrupts the running agent and injects new context.
          const escMsg = groupMessages.find((m) => {
            const stripped = m.content
              .trim()
              .replace(TRIGGER_PATTERN, '')
              .trim();
            return stripped === '/esc' || stripped.startsWith('/esc ');
          });
          if (escMsg) {
            if (
              isSessionCommandAllowed(
                isMainGroup,
                escMsg.is_from_me === true,
                isTrustedGroup,
              )
            ) {
              const stripped = escMsg.content
                .trim()
                .replace(TRIGGER_PATTERN, '')
                .trim();
              const extra = stripped.slice('/esc'.length).trim();
              const ipcText = extra
                ? `[User interrupted — adjust your plan accordingly]\n${extra}`
                : '[User interrupted — stop what you are doing and check in]';
              if (queue.sendInterrupt(chatJid, ipcText)) {
                logger.info(
                  { chatJid, extra },
                  '/esc interrupt sent to active container',
                );
                lastAgentTimestamp[chatJid] = escMsg.timestamp;
                saveState();
              } else {
                logger.debug(
                  { chatJid },
                  '/esc: no active container, ignoring',
                );
              }
            }
            continue;
          }
          // --- End /esc interrupt interception ---

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(
                m.content,
                getTriggerPattern(group.trigger),
              ) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
                isTrustedGroup,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = requiresTrigger;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

let cycleTimeoutPollerRunning = false;

/**
 * Periodically checks pendingCycles for delegations that have exceeded CYCLE_TIMEOUT.
 * On timeout: injects a notice into the main group's message queue so the agent knows
 * the sub-group never delivered a result, then removes the entry.
 * Implements rule CycleTimedOut from orchestration.allium.
 */
function startCycleTimeoutPoller(
  mainGroupJid: string,
  pollIntervalMs: number,
): void {
  if (cycleTimeoutPollerRunning) return;
  cycleTimeoutPollerRunning = true;

  const loop = () => {
    try {
      const now = Date.now();
      for (const [subGroupFolder, cycle] of Object.entries(pendingCycles)) {
        if (now - cycle.delegatedAt > CYCLE_TIMEOUT) {
          logger.warn(
            {
              subGroupFolder,
              taskId: cycle.taskId,
              ageMs: now - cycle.delegatedAt,
            },
            'Orchestration cycle timed out — injecting notice into main group',
          );
          storeMessage({
            id: `cycle-timeout-${subGroupFolder}-${now}`,
            chat_jid: mainGroupJid,
            sender: `system:${subGroupFolder}`,
            sender_name: subGroupFolder,
            content: `[Orchestration cycle timed out] Sub-group "${subGroupFolder}" (task ${cycle.taskId}) did not deliver a result within the allowed time.`,
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
          });
          delete pendingCycles[subGroupFolder];
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in cycle timeout poller');
    }
    setTimeout(loop, pollIntervalMs);
  };

  loop();
}

export { startCycleTimeoutPoller };

/** @internal — for tests only. */
export function _resetCycleTimeoutPollerForTest(): void {
  cycleTimeoutPollerRunning = false;
  for (const key of Object.keys(pendingCycles)) {
    delete pendingCycles[key];
  }
}

/** @internal — for tests only. */
export function _getPendingCyclesForTest(): Record<
  string,
  { taskId: string; delegatedAt: number }
> {
  return pendingCycles;
}

/**
 * On startup, scan all registered groups for non-placeholder ConversationArchives
 * that lack a corresponding SessionSummary. Spawn a throwaway agent for each to
 * produce the missing summary (RecoverOrphanedArchives spec rule).
 */
async function recoverOrphanedArchives(
  setReaction: (jid: string, emoji: string) => Promise<void>,
): Promise<void> {
  for (const [groupJid, group] of Object.entries(registeredGroups)) {
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const conversationsDir = path.join(groupDir, 'conversations');
    const sessionsDir = path.join(groupDir, 'memory', 'sessions');

    if (!fs.existsSync(conversationsDir)) continue;

    // Collect session_ids that already have summaries
    const summarisedSessionIds = new Set<string>();
    if (fs.existsSync(sessionsDir)) {
      for (const file of fs.readdirSync(sessionsDir)) {
        if (!file.endsWith('.md')) continue;
        try {
          const content = fs.readFileSync(
            path.join(sessionsDir, file),
            'utf-8',
          );
          const fm = parseFrontmatterField(content, 'session_id');
          if (fm) summarisedSessionIds.add(fm);
        } catch {
          // skip unreadable files
        }
      }
    }

    // Find non-placeholder archives without a summary
    for (const file of fs.readdirSync(conversationsDir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = fs.readFileSync(
          path.join(conversationsDir, file),
          'utf-8',
        );
        const isPlaceholder =
          parseFrontmatterField(content, 'is_placeholder') === 'true';
        if (isPlaceholder) continue;

        const sessionId = parseFrontmatterField(content, 'session_id');
        if (!sessionId) continue;
        if (summarisedSessionIds.has(sessionId)) continue;

        const jsonlPath = getSessionJsonlPath(group.folder, sessionId);
        logger.info(
          { groupFolder: group.folder, sessionId, file },
          'Recovering orphaned archive — spawning throwaway',
        );
        spawnThrowaway(group, groupJid, sessionId, jsonlPath, undefined, {
          sendMessage: async () => {},
          sendFile: async () => {},
          registeredGroups: () => ({}),
          registerGroup: () => {},
          setGroupTrusted: () => {},
          syncGroups: async () => {},
          startRemoteControl: async () => ({ ok: false, error: 'recovery' }),
          stopRemoteControl: async () => {},
          getAvailableGroups: () => [],
          writeGroupsSnapshot: () => {},
          onTasksChanged: () => {},
          setPendingDispatchDepth: () => {},
          setReaction,
        }).catch((err) =>
          logger.error({ err, sessionId }, 'Orphan recovery throwaway failed'),
        );
      } catch {
        // skip unreadable files
      }
    }
  }
}

/**
 * Watches the main group workspace for changes to memory/USER.md.
 * When the file is written by the weekly profile-generation task, updates
 * the in-memory UserProfile and persists it.
 */
async function startUserMdWatcher(): Promise<void> {
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (!mainEntry) return;
  const [, mainGroup] = mainEntry;
  const workspaceDir = path.join(GROUPS_DIR, mainGroup.folder);
  if (!fs.existsSync(workspaceDir)) return;

  // Lazy import to keep the watcher optional (same pattern as memory/manager.ts)
  const parcelWatcher = await import('@parcel/watcher');

  try {
    await parcelWatcher.subscribe(workspaceDir, (_err, events) => {
      if (_err) return;
      for (const event of events) {
        // Only fire on creates/updates — a deletion should not mark the profile current.
        if (event.type === 'delete') continue;
        // Normalise to a path relative to the workspace dir, forward slashes
        const rel = path.relative(workspaceDir, event.path).replace(/\\/g, '/');
        const now = new Date();
        const updated = onProfileFileUpdated(
          mainGroup,
          rel,
          warmStartProfile,
          now,
        );
        if (updated) {
          warmStartProfile = updated;
          saveUserProfile(warmStartProfile);
        }
      }
    });
    logger.info({ workspaceDir }, 'USER.md watcher started');
  } catch (err) {
    logger.warn({ err }, 'Failed to start USER.md watcher');
  }
}

/** Extract a single YAML frontmatter field value from a markdown file's content. */
function parseFrontmatterField(
  content: string,
  field: string,
): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (line.slice(0, colon).trim() === field) {
      return line.slice(colon + 1).trim();
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  ensureContainerRuntimeRunning();
  initDatabase();
  logger.info('Database initialized');
  initSpecialistTypes();
  loadState();
  queue.mainGroupJid =
    Object.entries(registeredGroups).find(([, g]) => g.isMain)?.[0] ?? null;

  // Load persisted UserProfile state and start the USER.md watcher for the main group.
  warmStartProfile = loadUserProfile();
  logger.info({ status: warmStartProfile.status }, 'UserProfile loaded');
  void startUserMdWatcher();

  // Eagerly initialize memory managers for groups with an existing index.
  // This triggers the startup sync (including any forced re-index from config
  // changes) without waiting for the first search to arrive.
  if (MEMORY_SEARCH_ENABLED) {
    void (async () => {
      for (const group of Object.values(registeredGroups)) {
        const dbPath = path.join(STORE_DIR, group.folder, 'embeddings.db');
        if (fs.existsSync(dbPath)) {
          await getOrCreateMemoryManager(group.folder).catch((err) =>
            logger.warn(
              { err, folder: group.folder },
              'Startup memory warm-up failed',
            ),
          );
        }
      }
    })();
  }

  // Recover orphaned containers from the previous process.
  // Instead of killing them immediately (which tears down Apple Container VMs
  // and fires macOS SCNetworkReachability events that freeze Tailscale SSH
  // sessions), we signal each orphan to wind down gracefully via _close and
  // hold its group slot in the queue until it exits naturally. Force-kill only
  // fires as a fallback if the container outlives its remaining timeout budget.
  const orphans = listOrphanedContainers();
  for (const orphan of orphans) {
    // Match container to a registered group by safe name
    const matchedEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.folder.replace(/[^a-zA-Z0-9-]/g, '-') === orphan.safeName,
    );
    const elapsed = Date.now() - orphan.startedMs;
    const remaining = CONTAINER_TIMEOUT - elapsed;
    if (matchedEntry && remaining > 0) {
      const [jid, group] = matchedEntry;
      queue.adoptOrphan(
        jid,
        orphan.name,
        group.folder,
        isContainerRunning,
        killContainer,
      );
    } else {
      // No matching group or already past timeout — kill immediately
      logger.info(
        { name: orphan.name, matched: !!matchedEntry, elapsed },
        'Stopping orphaned container (unmatched or timed out)',
      );
      killContainer(orphan.name);
    }
  }

  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start web dashboard (localhost only — exposed via tailscale serve on port 8443)
  const webUiServer = startWebUi(WEB_UI_PORT, undefined, {
    sendMessage: (jid, text) => routeOutbound(channels, jid, text),
    groupQueue: queue,
    syncGroups: () =>
      Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(true)),
      ).then(() => undefined),
  });

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    webUiServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    await closeAllMemoryManagers();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onTrustedGroupViolation: (jid: string, memberCount: number) => {
      const group = registeredGroups[jid];
      if (!group) return;
      const updated = { ...group, trustedGroup: undefined };
      setRegisteredGroup(jid, updated);
      registeredGroups[jid] = updated;
      logger.warn(
        { jid, memberCount },
        'Trusted group had members added — trusted status revoked',
      );
      const channel = findChannel(channels, jid);
      channel?.sendMessage(
        jid,
        `⚠️ This group now has ${memberCount} members. Trusted status (session commands) has been revoked. Remove extra members and re-enable via the MCP tool if needed.`,
      );
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    clearSession: (groupFolder) => {
      delete sessions[groupFolder];
      deleteSession(groupFolder);
    },
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, sender) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) {
        await channel.sendMessage(jid, text, sender);
        storeMessage({
          id: `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          chat_jid: jid,
          sender: sender ?? ASSISTANT_NAME,
          sender_name: sender ?? ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      }
    },
    getWarmStartPrompt: async (group) => {
      const stale = onProfileBecomesStale(warmStartProfile, new Date());
      if (stale) {
        warmStartProfile = stale;
        saveUserProfile(warmStartProfile);
      }
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.isMain,
      );
      const mainGroup = mainEntry?.[1];
      if (!mainGroup) return '';
      const mainGroupDir = path.join(GROUPS_DIR, mainGroup.folder);
      const memMgr = MEMORY_SEARCH_ENABLED
        ? await getOrCreateMemoryManager(mainGroup.folder).catch(() => null)
        : null;
      return buildWarmStartPrompt(
        group,
        mainGroupDir,
        warmStartProfile,
        memMgr,
      ).catch((err) => {
        logger.warn(
          { err },
          'Warm-start context assembly failed for scheduled task',
        );
        return '';
      });
    },
  });
  startRssMonitorLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, sender) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send RSS message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) {
        await channel.sendMessage(jid, text, sender);
        storeMessage({
          id: `rss-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          chat_jid: jid,
          sender: sender ?? ASSISTANT_NAME,
          sender_name: sender ?? ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      }
    },
  });
  startZoteroMonitorLoop({
    registeredGroups: () => registeredGroups,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, sender) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send Zotero message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) {
        await channel.sendMessage(jid, text, sender);
        storeMessage({
          id: `zotero-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          chat_jid: jid,
          sender: sender ?? ASSISTANT_NAME,
          sender_name: sender ?? ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        });
      }
    },
  });
  const setReactionFn = (jid: string, emoji: string): Promise<void> => {
    const channel = findChannel(channels, jid);
    return channel?.setReaction?.(jid, emoji) ?? Promise.resolve();
  };

  startIpcWatcher({
    sendMessage: async (jid, rawText, sender) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return;
      await channel.sendMessage(jid, text, sender);
      storeMessage({
        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        chat_jid: jid,
        sender: sender ?? ASSISTANT_NAME,
        sender_name: sender ?? ASSISTANT_NAME,
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    },
    sendFile: (jid, filePath, caption, _sender) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile)
        throw new Error(`Channel does not support file sending`);
      return channel.sendFile(jid, filePath, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    setGroupTrusted: (jid: string, trusted: boolean) => {
      const group = registeredGroups[jid];
      if (!group) return;
      const updated = { ...group, trustedGroup: trusted || undefined };
      setRegisteredGroup(jid, updated);
      registeredGroups[jid] = updated;
    },
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    startRemoteControl: (chatJid) =>
      startRemoteControl('ipc', chatJid, process.cwd()),
    stopRemoteControl: async (chatJid) => {
      const result = stopRemoteControl();
      const text = result.ok
        ? 'Remote control session ended.'
        : `Remote control: ${result.error}`;
      const channel = findChannel(channels, chatJid);
      await channel?.sendMessage(chatJid, text);
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    setPendingDispatchDepth: (jid, depth) => {
      if (registeredGroups[jid]) {
        registeredGroups[jid] = {
          ...registeredGroups[jid],
          pendingDispatchDepth: depth,
        };
      }
      setPendingDispatchDepthDb(jid, depth);
    },
    onCycleDelegated: (subGroupFolder, taskId) => {
      pendingCycles[subGroupFolder] = { taskId, delegatedAt: Date.now() };
      logger.debug({ subGroupFolder, taskId }, 'Orchestration cycle opened');
    },
    onCycleDelivered: (subGroupFolder) => {
      delete pendingCycles[subGroupFolder];
      logger.debug(
        { subGroupFolder },
        'Orchestration cycle closed (delivered)',
      );
    },
    setReaction: setReactionFn,
    onProcess: (jid, proc, containerName, groupFolder) =>
      queue.registerProcess(jid, proc, containerName, groupFolder),
    onProcessExit: (jid) => queue.deregisterProcess(jid),
  });
  // Wire up specialist container lifecycle
  const mainGroupEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain,
  );
  const mainGroupJid = mainGroupEntry?.[0];

  initSpecialists({
    startContainerFn: async (
      task: SpecialistTask,
      inject?: SpecialistTask | null,
    ) => {
      // Transition task to running
      updateSpecialistTask(task.id, { status: 'running' });

      // Retrieve session for continuity (resume previous conversation if present)
      const session = getSpecialistSession(task.id);
      const sessionId = session?.session_id;

      // Build prompt with optional last-turn notice and inject result
      const specialistTypeDef = getSpecialistType(task.specialist_type);
      let prompt = task.prompt;
      if (task.is_last_same_type_dispatch) {
        const notice =
          specialistTypeDef?.lastTurnSubNotice ??
          SPECIALISTS_CONFIG.defaultLastTurnSubNotice;
        prompt = `${notice}\n\n${prompt}`;
      }
      if (inject) {
        const injectBody =
          inject.status === 'completed'
            ? `[Specialist ${inject.specialist_type} result]:\n${inject.result ?? ''}`
            : `[Specialist ${inject.specialist_type} failed (${inject.failure_kind ?? 'unknown'})]`;
        if (inject.is_last_same_type_dispatch) {
          const parentNotice =
            specialistTypeDef?.lastTurnParentNotice ??
            SPECIALISTS_CONFIG.defaultLastTurnParentNotice;
          prompt = `${parentNotice}\n\n${prompt}\n\n${injectBody}`;
        } else {
          prompt = `${prompt}\n\n${injectBody}`;
        }
      }

      // Resolve specialist group folder (groups/specialists/{type})
      const hostGroupDir = resolveSpecialistGroupFolderPath(
        task.specialist_type,
      );

      // Flat folder name for IPC/session namespacing (must be a valid group folder)
      const specFolder = `spec-${task.id}`;

      // Build synthetic RegisteredGroup for the specialist container
      const specGroup: RegisteredGroup = {
        name: `specialist-${task.specialist_type}`,
        folder: specFolder,
        trigger: '',
        added_at: new Date().toISOString(),
        isMain: false,
        containerConfig: { timeout: SPECIALIST_CONTAINER_TIMEOUT },
      };

      // Extra readonly mounts for memory-provider specialists
      const extraReadonlyMounts: Array<{
        hostPath: string;
        containerPath: string;
      }> = [];
      if (specialistTypeDef?.isMemoryProvider && mainGroupEntry) {
        const mainGroupFolder = mainGroupEntry[1].folder;
        try {
          const mainFolderPath = resolveGroupFolderPath(mainGroupFolder);
          extraReadonlyMounts.push({
            hostPath: mainFolderPath,
            containerPath: '/workspace/extra/main-memory',
          });
        } catch {
          logger.warn(
            { mainGroupFolder, taskId: task.id },
            'Could not resolve main group folder for memory-provider mount',
          );
        }
      }

      // Mount Zotero markdown files read-only for researcher containers
      if (task.specialist_type === 'researcher' && ZOTERO_GROUP_FOLDER) {
        const zoteroMdPath = path.join(
          GROUPS_DIR,
          ZOTERO_GROUP_FOLDER,
          'zotero-md',
        );
        if (fs.existsSync(zoteroMdPath)) {
          extraReadonlyMounts.push({
            hostPath: zoteroMdPath,
            containerPath: '/workspace/zotero',
          });
        } else {
          logger.debug(
            { zoteroMdPath, taskId: task.id },
            'Zotero markdown directory does not exist yet, skipping mount',
          );
        }
      }

      // Route through the queue so specialists count against the
      // concurrency limit and appear in Active Containers.
      const specialistJid = makeSpecialistJid(task.id);
      queue.enqueueTask(specialistJid, task.id, async () => {
        const output = await runContainerAgent(
          specGroup,
          {
            prompt,
            sessionId,
            groupFolder: specFolder,
            chatJid: specialistJid,
            isMain: false,
            dispatchDepth: task.depth,
            hostGroupDir,
            specialistType: task.specialist_type,
            extraReadonlyMounts,
            onInvocationReady: (invocationId) => {
              placeFilesForInvocation(task.id, invocationId);
            },
          },
          (proc, containerName) =>
            queue.registerProcess(
              specialistJid,
              proc,
              containerName,
              specFolder,
            ),
        );
        if (output.status === 'error') {
          const current = getSpecialistTask(task.id);
          if (
            current &&
            current.status !== 'completed' &&
            current.status !== 'failed'
          ) {
            await failSpecialistTask(
              task.id,
              'execution_error',
              output.error ?? 'Container exited with error',
            );
          }
        }
      });
    },

    notifyMainGroupFn: async (groupJid: string, message: string) => {
      storeMessage({
        id: `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: groupJid,
        sender: 'system:specialist',
        sender_name: 'Specialist',
        content: message,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });
      // The main message loop will pick this up on the next poll
    },
  });

  // Recover specialist tasks that were live when the host was last killed
  await handleNanoclawStarted(mainGroupJid);

  // Recover orphaned archives (archives without a SessionSummary)
  recoverOrphanedArchives(setReactionFn).catch((err) =>
    logger.error({ err }, 'Orphaned archive recovery failed'),
  );

  // Start periodic check for specialist tasks exceeding overall duration limit
  startOverdueSpecialistPoller(SCHEDULER_POLL_INTERVAL);

  // Start periodic check for staged memory submissions that have not been processed
  if (mainGroupJid) {
    startStagedSubmissionOverduePoller(mainGroupJid, SCHEDULER_POLL_INTERVAL);
  }

  // Start periodic check for orchestration cycles that have exceeded cycle_timeout
  if (mainGroupJid) {
    startCycleTimeoutPoller(mainGroupJid, SCHEDULER_POLL_INTERVAL);
  }

  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
