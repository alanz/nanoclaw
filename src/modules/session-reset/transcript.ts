/**
 * Host-side reads of what the container owns: the current conversation id in
 * outbound.db, and the provider's transcript on disk. Read-only throughout —
 * outbound.db keeps a single writer, the container.
 *
 * The markdown conversion mirrors the runner's PreCompact archive
 * (container/agent-runner/src/providers/claude-history.ts). Host and container
 * share no modules, so it is restated here rather than imported.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { openOutboundDb } from '../../mailbox/sqlite/session-db.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';

export interface SessionActivity {
  /** The provider's current conversation id, or null when none is stored. */
  conversationId: string | null;
  /** Newest messages_out timestamp, ISO, or null. */
  lastOutboundAt: string | null;
}

/**
 * Read the session's current conversation id and its newest outbound message.
 * Undefined when the session has no outbound.db yet (never ran).
 */
export function readSessionActivity(
  agentGroupId: string,
  sessionId: string,
  provider: string,
): SessionActivity | undefined {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return undefined;
  const db = openOutboundDb(dbPath);
  try {
    const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_state'").get();
    let conversationId: string | null = null;
    if (hasState) {
      // The runner folds the legacy key into the provider key at startup;
      // until then the legacy one is still the live id.
      const row = db
        .prepare(
          `SELECT value FROM session_state WHERE key IN (?, 'sdk_session_id')
           ORDER BY CASE key WHEN ? THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(`continuation:${provider}`, `continuation:${provider}`) as { value: string } | undefined;
      conversationId = row?.value || null;
    }
    const out = db.prepare('SELECT MAX(timestamp) AS t FROM messages_out').get() as { t: string | null } | undefined;
    return { conversationId, lastOutboundAt: out?.t ?? null };
  } finally {
    db.close();
  }
}

/** Where the group's Claude transcripts live on the host (shared by all its sessions). */
export function claudeTranscriptDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'projects', '-workspace-agent');
}

export interface TranscriptLocation {
  path: string;
  rotated: boolean;
}

/** The conversation's transcript: `<id>.jsonl`, or the newest `<id>.jsonl.rotated-<ms>`. */
export function findTranscript(agentGroupId: string, conversationId: string): TranscriptLocation | undefined {
  const dir = claudeTranscriptDir(agentGroupId);
  const live = path.join(dir, `${conversationId}.jsonl`);
  if (fs.existsSync(live)) return { path: live, rotated: false };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const prefix = `${conversationId}.jsonl.rotated-`;
  const rotated = names
    .filter((n) => n.startsWith(prefix))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  return rotated[0] ? { path: path.join(dir, rotated[0]), rotated: true } : undefined;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MESSAGE_CAP = 2000;

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const body = entry.message?.content;
    if (!body) continue;
    if (entry.type === 'user') {
      const text =
        typeof body === 'string'
          ? body
          : Array.isArray(body)
            ? body.map((part: { text?: string }) => part.text || '').join('')
            : '';
      if (text) messages.push({ role: 'user', content: text });
    } else if (entry.type === 'assistant' && Array.isArray(body)) {
      const text = body
        .filter((part: { type?: string }) => part.type === 'text')
        .map((part: { text?: string }) => part.text || '')
        .join('');
      if (text) messages.push({ role: 'assistant', content: text });
    }
  }
  return messages;
}

export interface ArchiveHeader {
  sessionId: string;
  conversationId: string;
  endReason: string;
  archivedAt: string;
  transcript: string | null;
}

export function formatArchive(header: ArchiveHeader, messages: ParsedMessage[], assistantName: string): string {
  const lines = [
    '---',
    `session: ${header.sessionId}`,
    `conversation_id: ${header.conversationId}`,
    `end_reason: ${header.endReason}`,
    `archived_at: ${header.archivedAt}`,
    `transcript: ${header.transcript ?? 'missing'}`,
    `messages: ${messages.length}`,
    '---',
    '',
    `# Conversation (${header.endReason})`,
    '',
  ];
  for (const message of messages) {
    const sender = message.role === 'user' ? 'User' : assistantName;
    const text = message.content.length > MESSAGE_CAP ? `${message.content.slice(0, MESSAGE_CAP)}...` : message.content;
    lines.push(`**${sender}**: ${text}`, '');
  }
  return lines.join('\n');
}

/** `base` + `.md`, or `base-2.md`, `base-3.md`… — the first name not already taken in `dir`. */
export function freeName(dir: string, base: string): string {
  let name = `${base}.md`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}.md`;
  return name;
}
