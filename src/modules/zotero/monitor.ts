import { ZOTERO_GROUP_FOLDER, ZOTERO_POLL_INTERVAL } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import {
  getZoteroSyncState,
  updateAfterSync,
  updateNextCheck,
  upsertZoteroSyncState,
} from './db.js';
import { notifySyncChanges } from './notify.js';
import { fetchLibraryVersion } from './pre-check.js';
import { computeNextZoteroCheck } from './schedule.js';
import { queueEnrichmentTask, queueSyncTask, readSyncResult } from './sync.js';

const MONITOR_POLL_MS = 30_000;

let monitorRunning = false;

export function startZoteroMonitor(): void {
  if (!ZOTERO_GROUP_FOLDER) {
    log.debug('Zotero monitor: ZOTERO_GROUP_FOLDER not set, skipping');
    return;
  }

  if (monitorRunning) return;
  monitorRunning = true;

  log.info('Zotero monitor starting', { groupFolder: ZOTERO_GROUP_FOLDER });
  void monitorTick();
}

async function monitorTick(): Promise<void> {
  if (!monitorRunning) return;

  try {
    await runMonitor();
  } catch (err) {
    log.error('Zotero monitor error', { err });
  }

  setTimeout(() => void monitorTick(), MONITOR_POLL_MS);
}

async function runMonitor(): Promise<void> {
  const folder = ZOTERO_GROUP_FOLDER!;
  const agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    log.warn('Zotero: agent group not found', { folder });
    return;
  }

  let state = getZoteroSyncState();

  // Bootstrap: initialise the singleton row on first run
  if (!state) {
    upsertZoteroSyncState({
      agent_group_id: agentGroup.id,
      last_version: 0,
      total_items: 0,
      last_sync: null,
      next_check: new Date().toISOString(),
      schedule_type: 'interval',
      schedule_value: String(ZOTERO_POLL_INTERVAL),
    });
    log.info('Zotero: sync state initialised', { folder, pollIntervalMs: ZOTERO_POLL_INTERVAL });
    return;
  }

  // Step 1: detect a sync result written by the container (lastSync changed)
  const result = readSyncResult(folder);
  if (result?.lastSync && result.lastSync !== state.last_sync) {
    log.info('Zotero: sync result detected', {
      newVersion: result.newVersion,
      newCount: result.newCount,
      deletedCount: result.deletedCount,
    });

    const nextCheck = computeNextZoteroCheck({
      schedule_type: state.schedule_type,
      schedule_value: state.schedule_value,
      next_check: state.next_check,
    });
    updateAfterSync(result.newVersion, result.totalItems, result.lastSync, nextCheck);

    if (result.newCount > 0 || result.deletedCount > 0) {
      await notifySyncChanges(agentGroup.id, folder, result);

      // Trigger abstract enrichment for new items without abstracts
      if (result.newCount > 0) {
        queueEnrichmentTask(folder);
      }
    }

    return;
  }

  // Step 2: schedule first check if no next_check yet
  if (!state.next_check) {
    updateNextCheck(new Date().toISOString());
    return;
  }

  // Step 3: check if sync is due
  if (new Date(state.next_check) > new Date()) return;

  // Step 4: lightweight pre-check — only spawn container if library changed
  const serverVersion = await fetchLibraryVersion(state.last_version);

  if (serverVersion === null) {
    // Credentials missing or API unreachable — skip and advance schedule
    log.info('Zotero: pre-check failed, advancing schedule');
    updateNextCheck(computeNextZoteroCheck(state));
    return;
  }

  if (serverVersion <= state.last_version) {
    log.debug('Zotero: library unchanged', { serverVersion, lastVersion: state.last_version });
    updateNextCheck(computeNextZoteroCheck(state));
    return;
  }

  // Step 5: library changed — advance next_check immediately to prevent
  // duplicate task queuing on restart, then queue the sync
  log.info('Zotero: library changed, queuing sync', {
    serverVersion,
    lastVersion: state.last_version,
  });
  updateNextCheck(computeNextZoteroCheck(state));
  queueSyncTask(folder, state.last_version);
}

/** @internal for tests only */
export function _resetZoteroMonitorForTests(): void {
  monitorRunning = false;
}
