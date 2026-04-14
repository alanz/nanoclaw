/**
 * Persistent state for WebXDC sessions over DeltaChat.
 *
 * Tracks:
 *   - Active webxdc message ID per JID (jid → msgId)
 *   - Queued updates per msgId (survive bot restarts)
 *
 * Stored in store/deltachat-webxdc.json.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

const STORE_PATH = path.join(DATA_DIR, 'deltachat-webxdc.json');

export interface WebxdcUpdateItem {
  content: string;
  title: string;
  timestamp: number;
  /** 'message' (default) or 'interactive' */
  type?: string;
  /** Named surface: updates the card in-place instead of appending */
  surfaceId?: string;
  /** Interactive component definitions */
  components?: unknown[];
  /** Short description shown as the email subject / update label */
  description?: string;
}

interface WebxdcStoreData {
  /** jid → active webxdc msgId */
  sessions: Record<string, number>;
  /** msgId (as string) → pending update items */
  queues: Record<string, WebxdcUpdateItem[]>;
}

let data: WebxdcStoreData = { sessions: {}, queues: {} };

function load(): void {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      data = {
        sessions: raw.sessions ?? {},
        queues: raw.queues ?? {},
      };
    }
  } catch (err) {
    logger.warn({ err }, 'webxdc-store: failed to load, starting fresh');
    data = { sessions: {}, queues: {} };
  }
}

function save(): void {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error({ err }, 'webxdc-store: failed to save');
  }
}

load();

/** Return the active webxdc msgId for a JID, or undefined if none. */
export function getActiveWebxdcMsgId(jid: string): number | undefined {
  return data.sessions[jid];
}

/** Record a newly sent webxdc app message as the active session for a JID. */
export function setActiveWebxdcSession(jid: string, msgId: number): void {
  data.sessions[jid] = msgId;
  // Clear any stale queue for the new msgId
  delete data.queues[String(msgId)];
  save();
}

/** Remove the active webxdc session and its queue for a JID. */
export function clearWebxdcSession(jid: string): void {
  const msgId = data.sessions[jid];
  if (msgId !== undefined) {
    delete data.queues[String(msgId)];
    delete data.sessions[jid];
    save();
  }
}

/** Add an update item to the queue for a msgId. */
export function enqueueWebxdcUpdate(
  msgId: number,
  item: WebxdcUpdateItem,
): void {
  const key = String(msgId);
  if (!data.queues[key]) data.queues[key] = [];
  data.queues[key].push(item);
  save();
}

/**
 * Remove and return all queued items for a msgId.
 * Called after successful delivery so items are not re-sent.
 */
export function dequeueWebxdcUpdates(msgId: number): WebxdcUpdateItem[] {
  const key = String(msgId);
  const items = data.queues[key] ?? [];
  data.queues[key] = [];
  save();
  return items;
}

/** Return queued items without removing them (used for realtime peek). */
export function peekWebxdcUpdates(msgId: number): WebxdcUpdateItem[] {
  return data.queues[String(msgId)] ?? [];
}
