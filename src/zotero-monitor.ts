import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
  ZOTERO_CHAT_JID,
  ZOTERO_GROUP_FOLDER,
  ZOTERO_OUTPUT_DIR,
  ZOTERO_POLL_INTERVAL,
} from './config.js';
import { runContainerAgent } from './container-runner.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const STATE_FILE = 'zotero-state.json';

export interface ZoteroState {
  lastVersion: number;
  totalItems: number;
  lastSync: string | null;
  nextCheck: string | null;
  // schedule is stored here so it survives restarts
  scheduleType: 'interval' | 'cron';
  scheduleValue: string;
}

const DEFAULT_STATE: ZoteroState = {
  lastVersion: 0,
  totalItems: 0,
  lastSync: null,
  nextCheck: null,
  scheduleType: 'interval',
  scheduleValue: String(ZOTERO_POLL_INTERVAL),
};

function readState(groupFolder: string): ZoteroState {
  const filePath = path.join(resolveGroupFolderPath(groupFolder), STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ZoteroState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(groupFolder: string, state: ZoteroState): void {
  const groupDir = resolveGroupFolderPath(groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, STATE_FILE),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

/**
 * Compute the next check time.
 * Exported for testing.
 */
export function computeNextZoteroCheck(
  state: Pick<ZoteroState, 'scheduleType' | 'scheduleValue' | 'nextCheck'>,
  from?: Date,
): string {
  const now = (from ?? new Date()).getTime();

  if (state.scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(state.scheduleValue, {
      tz: TIMEZONE,
    });
    return (
      interval.next().toISOString() ??
      new Date(now + ZOTERO_POLL_INTERVAL).toISOString()
    );
  }

  // interval — advance from last scheduled time, skipping missed windows
  const ms = parseInt(state.scheduleValue, 10);
  let next =
    new Date(state.nextCheck ?? new Date(now - ms).toISOString()).getTime() +
    ms;
  while (next <= now) {
    next += ms;
  }
  return new Date(next).toISOString();
}

/**
 * Build the prompt sent to the container agent.
 * Exported for testing.
 */
export function buildZoteroSyncPrompt(
  lastVersion: number,
  outputDir: string,
): string {
  return (
    `Run the Zotero library sync to fetch new or updated items.\n\n` +
    `Execute:\n` +
    `\`\`\`\n` +
    `node /workspace/tools/zotero-sync.mjs --since ${lastVersion} --output ${outputDir}\n` +
    `\`\`\`\n\n` +
    `The command prints a JSON object. Parse it and reply with a brief summary:\n` +
    `- How many items were synced (newCount) and deleted (deletedCount)\n` +
    `- Titles of up to 5 new items (from the items array)\n` +
    `- Total items now in the library (totalItems)\n\n` +
    `If newCount is 0 and deletedCount is 0, respond with nothing (empty reply).`
  );
}

/**
 * Cheap pre-check: ask Zotero if the library version has advanced since
 * lastVersion. Returns true if there are new/modified items (or if the check
 * can't be performed — fail open so a full sync still runs).
 * Exported for testing.
 */
export async function hasNewZoteroItems(lastVersion: number): Promise<boolean> {
  const env = readEnvFile(['ZOTERO_API_KEY', 'ZOTERO_USER_ID']);
  const apiKey = env.ZOTERO_API_KEY;
  const userId = env.ZOTERO_USER_ID;

  if (!apiKey || !userId) {
    logger.debug(
      'Zotero credentials not available for pre-check, assuming new items',
    );
    return true;
  }

  const url =
    `https://api.zotero.org/users/${userId}/items` +
    `?since=${lastVersion}&format=versions&limit=1`;

  try {
    const res = await fetch(url, {
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-API-Version': '3',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'Zotero version pre-check failed, assuming new items',
      );
      return true;
    }

    const serverVersion = parseInt(
      res.headers.get('Last-Modified-Version') ?? '0',
      10,
    );
    const hasNew = serverVersion > lastVersion;
    logger.debug(
      { lastVersion, serverVersion, hasNew },
      'Zotero version pre-check',
    );
    return hasNew;
  } catch (err) {
    logger.warn({ err }, 'Zotero version pre-check error, assuming new items');
    return true;
  }
}

export interface ZoteroMonitorDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runZoteroSync(deps: ZoteroMonitorDeps): Promise<void> {
  const groupFolder = ZOTERO_GROUP_FOLDER!;
  const chatJid = ZOTERO_CHAT_JID!;
  const startTime = Date.now();

  logger.info({ groupFolder }, 'Running Zotero sync');

  const state = readState(groupFolder);
  const nextCheck = computeNextZoteroCheck(state);

  // Persist next_check immediately to prevent duplicate runs on restart
  writeState(groupFolder, { ...state, nextCheck });

  // Cheap pre-check: skip container spawn if library hasn't changed
  const newItems = await hasNewZoteroItems(state.lastVersion);
  if (!newItems) {
    logger.debug(
      { lastVersion: state.lastVersion },
      'Zotero pre-check: no new items, skipping sync',
    );
    return;
  }

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find((g) => g.folder === groupFolder);
  if (!group) {
    logger.warn({ groupFolder }, 'Zotero group not registered, skipping');
    return;
  }

  const prompt = buildZoteroSyncPrompt(state.lastVersion, ZOTERO_OUTPUT_DIR);
  const isMain = group.isMain === true;

  const TASK_CLOSE_DELAY_MS = 10_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    await runContainerAgent(
      group,
      {
        prompt,
        sessionId: undefined,
        groupFolder,
        chatJid,
        isMain,
        isScheduledTask: true,
        assistantName: undefined,
      },
      (proc, containerName) =>
        deps.onProcess(chatJid, proc, containerName, groupFolder),
      async (streamedOutput) => {
        if (streamedOutput.result) {
          await deps.sendMessage(chatJid, streamedOutput.result);
          const digestPath = path.join(
            resolveGroupFolderPath(groupFolder),
            'zotero-digest.md',
          );
          const entry =
            `\n\n## ${new Date().toISOString()}\n\n` + streamedOutput.result;
          fs.appendFileSync(digestPath, entry);
          if (!closeTimer) {
            closeTimer = setTimeout(() => {
              deps.queue.closeStdin(chatJid);
            }, TASK_CLOSE_DELAY_MS);
          }
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(chatJid);
          if (!closeTimer) {
            closeTimer = setTimeout(() => {
              deps.queue.closeStdin(chatJid);
            }, TASK_CLOSE_DELAY_MS);
          }
        }
      },
    );
  } catch (err) {
    logger.error({ err }, 'Zotero sync container failed');
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
  }

  // Read state written by zotero-sync.mjs and merge it back
  const syncStatePath = path.join(
    resolveGroupFolderPath(groupFolder),
    STATE_FILE,
  );
  try {
    const syncResult = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as {
      newVersion: number;
      totalItems: number;
      lastSync: string;
    };
    writeState(groupFolder, {
      ...state,
      nextCheck,
      lastVersion: syncResult.newVersion,
      totalItems: syncResult.totalItems,
      lastSync: syncResult.lastSync,
    });
    logger.info(
      { newVersion: syncResult.newVersion, totalItems: syncResult.totalItems },
      'Zotero state updated',
    );
  } catch {
    logger.warn({ groupFolder }, 'Zotero state file not found after sync');
  }

  logger.info({ durationMs: Date.now() - startTime }, 'Zotero sync complete');
}

let zoteroMonitorRunning = false;

export function startZoteroMonitorLoop(deps: ZoteroMonitorDeps): void {
  if (!ZOTERO_GROUP_FOLDER || !ZOTERO_CHAT_JID) {
    logger.debug(
      'Zotero not configured (ZOTERO_GROUP_FOLDER / ZOTERO_CHAT_JID not set), skipping',
    );
    return;
  }

  if (zoteroMonitorRunning) {
    logger.debug(
      'Zotero monitor loop already running, skipping duplicate start',
    );
    return;
  }
  zoteroMonitorRunning = true;
  // Capture as non-null locals — guard above guarantees these are set
  const groupFolder = ZOTERO_GROUP_FOLDER as string;
  const chatJid = ZOTERO_CHAT_JID as string;
  logger.info({ groupFolder }, 'Zotero monitor loop started');

  const loop = async () => {
    try {
      const state = readState(groupFolder);
      const now = new Date();

      // First run (no nextCheck yet): schedule first check immediately
      if (!state.nextCheck) {
        writeState(groupFolder, {
          ...state,
          nextCheck: now.toISOString(),
        });
      }

      const isDue = state.nextCheck != null && new Date(state.nextCheck) <= now;

      if (isDue) {
        deps.queue.enqueueTask(chatJid, 'zotero-sync', () =>
          runZoteroSync(deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in Zotero monitor loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetZoteroMonitorLoopForTests(): void {
  zoteroMonitorRunning = false;
}
