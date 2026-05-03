import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { createSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const SYNC_STATE_FILE = 'zotero-state.json';

export interface ZoteroSyncResult {
  newVersion: number;
  totalItems: number;
  lastSync: string;
  newCount: number;
  deletedCount: number;
  addedItems: Array<{ key: string; title: string }>;
}

/**
 * Read the sync result written by zotero-sync.mjs in the container.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readSyncResult(agentGroupFolder: string): ZoteroSyncResult | null {
  const filePath = path.join(GROUPS_DIR, agentGroupFolder, SYNC_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ZoteroSyncResult;
  } catch {
    return null;
  }
}

/**
 * Find or create a dedicated background session for the agent group.
 * Background sessions have messaging_group_id = null and are used for
 * host-initiated tasks like Zotero sync that don't originate from a chat.
 */
function findOrCreateBackgroundSession(agentGroupId: string): Session {
  const existing = getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS NULL AND status = 'active' LIMIT 1",
    )
    .get(agentGroupId) as Session | undefined;

  if (existing) return existing;

  const id = `sess-zotero-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Zotero background session created', { sessionId: id, agentGroupId });
  return session;
}

/**
 * Write a sync task into the agent group's background session inbound.db.
 * The container will pick it up, run zotero-sync.mjs, and write the result
 * to /workspace/agent/zotero-state.json. No chat message is produced.
 */
export function queueSyncTask(agentGroupFolder: string, lastVersion: number): void {
  const agentGroup = getAgentGroupByFolder(agentGroupFolder);
  if (!agentGroup) {
    log.warn('Zotero: agent group not found', { folder: agentGroupFolder });
    return;
  }

  const session = findOrCreateBackgroundSession(agentGroup.id);

  const outputDir = '/workspace/agent/zotero-md';
  const prompt =
    `Run the Zotero library sync to fetch new or updated items.\n\n` +
    `Execute:\n` +
    `\`\`\`\n` +
    `node /app/tools/zotero-sync.mjs --since ${lastVersion} --output ${outputDir}\n` +
    `\`\`\`\n\n` +
    `The command will write results to /workspace/agent/zotero-state.json. ` +
    `When done, do not send any message.`;

  const taskId = `task-zotero-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeSessionMessage(agentGroup.id, session.id, {
    id: taskId,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt, script: null }),
    trigger: 1,
  });

  log.info('Zotero sync task queued', { taskId, sessionId: session.id, lastVersion });
}

/**
 * Queue an enrichment task that runs both the external-source enrichment
 * and the PDF abstract extraction tools on all items without abstracts.
 * Triggered automatically after a sync that added new items.
 */
export function queueEnrichmentTask(agentGroupFolder: string): void {
  const agentGroup = getAgentGroupByFolder(agentGroupFolder);
  if (!agentGroup) return;

  const session = findOrCreateBackgroundSession(agentGroup.id);
  const dir = '/workspace/agent/zotero-md';
  const prompt =
    `Enrich Zotero item abstracts for items that are missing them.\n\n` +
    `Run both tools in sequence:\n\n` +
    `\`\`\`\n` +
    `node /app/tools/zotero-enrich.mjs --dir ${dir}\n` +
    `\`\`\`\n\n` +
    `\`\`\`\n` +
    `node /app/tools/zotero-extract-abstracts.mjs --dir ${dir}\n` +
    `\`\`\`\n\n` +
    `When both are done, do not send any message.`;

  const taskId = `task-zotero-enrich-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeSessionMessage(agentGroup.id, session.id, {
    id: taskId,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt, script: null }),
    trigger: 1,
  });

  log.info('Zotero enrichment task queued', { taskId, sessionId: session.id });
}
