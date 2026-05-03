import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { ZoteroSyncResult } from './sync.js';

export function buildSyncSummary(result: ZoteroSyncResult): string {
  const parts: string[] = [];

  if (result.newCount > 0) {
    parts.push(`${result.newCount} new item${result.newCount !== 1 ? 's' : ''} added to Zotero library`);
    const preview = result.addedItems.slice(0, 5);
    if (preview.length > 0) {
      parts.push(preview.map((i) => `• ${i.title}`).join('\n'));
    }
    if (result.addedItems.length > 5) {
      parts.push(`...and ${result.addedItems.length - 5} more`);
    }
  }

  if (result.deletedCount > 0) {
    parts.push(`${result.deletedCount} item${result.deletedCount !== 1 ? 's' : ''} removed`);
  }

  parts.push(`Total: ${result.totalItems} items`);
  return parts.join('\n');
}

/**
 * Append a timestamped entry to the group's zotero-digest.md log and
 * deliver the summary directly to all messaging groups wired to the agent,
 * bypassing the session DB path entirely.
 */
export async function notifySyncChanges(
  agentGroupId: string,
  agentGroupFolder: string,
  result: ZoteroSyncResult,
): Promise<void> {
  if (result.newCount === 0 && result.deletedCount === 0) return;

  const summary = buildSyncSummary(result);

  // Append to digest
  const digestPath = path.join(GROUPS_DIR, agentGroupFolder, 'zotero-digest.md');
  const entry = `\n\n## ${new Date().toISOString()}\n\n${summary}`;
  try {
    fs.appendFileSync(digestPath, entry);
  } catch (err) {
    log.warn('Zotero: failed to write digest', { err });
  }

  // Deliver directly to all wired messaging groups via the channel adapters
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Zotero: delivery adapter not ready, skipping notification');
    return;
  }

  const messagingGroups = getMessagingGroupsByAgentGroup(agentGroupId);
  for (const mg of messagingGroups) {
    try {
      await adapter.deliver(mg.channel_type, mg.platform_id, null, 'text', JSON.stringify({ text: summary }));
      log.info('Zotero notification sent', { channelType: mg.channel_type, platformId: mg.platform_id });
    } catch (err) {
      log.warn('Zotero: failed to deliver notification', { channelType: mg.channel_type, err });
    }
  }
}
