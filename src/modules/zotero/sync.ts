import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { createSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { initSessionFolder, withMailboxSession, writeSessionMessage } from '../../session-manager.js';
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
async function findOrCreateBackgroundSession(agentGroupId: string): Promise<Session> {
  const existing = (await getDb().get(
    "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS NULL AND status = 'active' LIMIT 1",
    agentGroupId,
  )) as Session | undefined;

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
    processing_state: 'idle',
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
export async function queueSyncTask(agentGroupFolder: string, lastVersion: number): Promise<void> {
  const agentGroup = await getAgentGroupByFolder(agentGroupFolder);
  if (!agentGroup) {
    log.warn('Zotero: agent group not found', { folder: agentGroupFolder });
    return;
  }

  const session = await findOrCreateBackgroundSession(agentGroup.id);

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
  await writeSessionMessage(agentGroup.id, session.id, {
    id: taskId,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt, script: null }),
    trigger: true,
  });

  log.info('Zotero sync task queued', { taskId, sessionId: session.id, lastVersion });
}

// zotero.allium config: abstract_retry_interval, enrichment_run_budget. The
// budget stays under the container's 30 s pre-task script timeout.
const ABSTRACT_RETRY_MS = 180 * 86_400_000;
export const ENRICHMENT_RUN_BUDGET_SECONDS = 25;
const ENRICH_TASK_PREFIX = 'task-zotero-enrich-';
const LOOKUP_RE = /^abstract_lookup: (\S+) (not_found|inconclusive)\s*$/m;

/**
 * Whether one item file is in the enrichment backlog: no abstract, and not a
 * not_found lookup younger than the retry interval. Mirrors inBacklog in
 * container/tools/zotero-frontmatter.mjs (host and container share no code).
 */
export function itemInBacklog(text: string, now: Date): boolean {
  if (!text.startsWith('---')) return false;
  const nl = text.indexOf('\n');
  const end = text.indexOf('\n---', nl + 1);
  if (nl < 0 || end < 0) return false;
  const bodyStart = end + 4 + (text[end + 4] === '\n' ? 1 : 0);
  const bodyLines = text
    .slice(bodyStart)
    .split('\n')
    .filter((l) => l.trim());
  if (bodyLines.length > 2) return false; // has an abstract
  const lookup = text.slice(nl + 1, end).match(LOOKUP_RE);
  if (!lookup || lookup[2] !== 'not_found') return true;
  const at = Date.parse(lookup[1]);
  return Number.isNaN(at) || now.getTime() - at >= ABSTRACT_RETRY_MS;
}

/** Item keys in the backlog, optionally limited to `keys`. */
export function enrichmentBacklog(agentGroupFolder: string, now = new Date(), keys?: string[]): string[] {
  const dir = path.join(GROUPS_DIR, agentGroupFolder, 'zotero-md');
  let names: string[];
  try {
    names = keys ? keys.map((k) => `${k}.md`) : fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      return itemInBacklog(fs.readFileSync(path.join(dir, name), 'utf-8'), now) ? [name.slice(0, -3)] : [];
    } catch {
      return [];
    }
  });
}

/**
 * zotero.allium EnrichmentRun: queue one budgeted lookup pass over the backlog
 * as a pre-task script that never wakes the agent, so it costs no model turn.
 * The pass writes its results into the item files. At most one run is queued
 * at a time: a run still waiting in the background session is enough.
 */
export async function queueEnrichmentTask(agentGroupFolder: string): Promise<boolean> {
  const agentGroup = await getAgentGroupByFolder(agentGroupFolder);
  if (!agentGroup) return false;

  const session = await findOrCreateBackgroundSession(agentGroup.id);
  const waiting = await withMailboxSession(agentGroup.id, session.id, (mailbox) =>
    mailbox.listLiveTasks('pending').some((t) => t.id.startsWith(ENRICH_TASK_PREFIX)),
  );
  if (waiting) {
    log.debug('Zotero enrichment run already queued', { sessionId: session.id });
    return false;
  }

  const script =
    `out=$(node /app/tools/zotero-abstracts.mjs --dir /workspace/agent/zotero-md ` +
    `--budget-seconds ${ENRICHMENT_RUN_BUDGET_SECONDS}) || out=null\n` +
    `printf '{"wakeAgent":false,"data":%s}\\n' "\${out:-null}"\n`;
  const prompt = 'Zotero abstract enrichment pass (runs as a script; no agent turn).';

  const taskId = `${ENRICH_TASK_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeSessionMessage(agentGroup.id, session.id, {
    id: taskId,
    kind: 'task',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt, script }),
    trigger: true,
  });

  log.info('Zotero enrichment run queued', { taskId, sessionId: session.id });
  return true;
}
