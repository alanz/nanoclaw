/**
 * Post-mortem for a failed specialist task: what the specialist was doing
 * when it stopped, appended to the failure its requester receives.
 *
 * v1 did this from the specialist's transcript (`_buildPostMortem`); without
 * it the requester got only "Specialist task failed: timeout" and could not
 * tell a fetch that hung from an API error from a model that went quiet.
 *
 * Sources, read-only: the task session's current conversation id in its
 * outbound.db, that conversation's Claude transcript (the group's shared
 * .claude-shared/projects dir), and the newest runner run log in the session
 * folder. Each is optional — a specialist that never started has none.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { openOutboundDb } from '../../mailbox/sqlite/session-db.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';

/** Only the transcript's tail is read: the end is what explains a failure. */
const TAIL_BYTES = 256 * 1024;

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function squash(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join(' ');
  }
  return '';
}

/** Summarise a transcript's tail. Exported for tests. */
export function summariseTranscript(jsonl: string): string[] {
  let lastTool: string | null = null;
  let lastResult: string | null = null;
  let lastResultIsError = false;
  let apiError: string | null = null;
  let lastText: string | null = null;

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of a tail is usually cut
    }
    const blocks = Array.isArray(entry.message?.content) ? (entry.message.content as ContentBlock[]) : [];
    if (entry.type === 'assistant') {
      if (entry.isApiErrorMessage) {
        apiError = squash(resultText(blocks), 200);
        continue;
      }
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          lastTool = `${b.name ?? '?'}(${squash(JSON.stringify(b.input ?? {}), 120)})`;
          lastResult = null;
          lastResultIsError = false;
        } else if (b.type === 'text' && b.text?.trim()) {
          lastText = squash(b.text, 200);
        }
      }
    } else if (entry.type === 'user') {
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue;
        lastResult = squash(resultText(b.content), 160) || null;
        lastResultIsError = b.is_error === true;
      }
    }
  }

  const lines: string[] = [];
  if (lastTool) {
    lines.push(`• Last tool: ${lastTool}`);
    lines.push(lastResult ? `  → ${lastResultIsError ? 'error: ' : ''}${lastResult}` : '  → no result (still running)');
  }
  if (apiError) lines.push(`• API error: ${apiError}`);
  if (lastText) lines.push(`• Last said: ${lastText}`);
  return lines;
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function conversationId(agentGroupId: string, sessionId: string): string | null {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return null;
  const db = openOutboundDb(dbPath);
  try {
    const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_state'").get();
    if (!hasState) return null;
    const row = db
      .prepare(
        `SELECT value FROM session_state WHERE key LIKE 'continuation:%' OR key = 'sdk_session_id'
         ORDER BY CASE WHEN key LIKE 'continuation:%' THEN 0 ELSE 1 END LIMIT 1`,
      )
      .get() as { value: string } | undefined;
    return row?.value || null;
  } finally {
    db.close();
  }
}

function transcriptPath(agentGroupId: string, id: string): string | null {
  const dir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'projects', '-workspace-agent');
  const live = path.join(dir, `${id}.jsonl`);
  if (fs.existsSync(live)) return live;
  try {
    const prefix = `${id}.jsonl.rotated-`;
    const rotated = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
    return rotated[0] ? path.join(dir, rotated[0]) : null;
  } catch {
    return null;
  }
}

/** The last line the runner logged (container/agent-runner/src/run-log.ts), if any. */
function lastRunLogLine(agentGroupId: string, sessionId: string): string | null {
  const dir = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'logs');
  try {
    const newest = fs
      .readdirSync(dir)
      .filter((n) => n.includes('-runner-') && n.endsWith('.log'))
      .sort()
      .at(-1);
    if (!newest) return null;
    const last = readTail(path.join(dir, newest)).trimEnd().split('\n').at(-1);
    return last ? squash(last, 200) : null;
  } catch {
    return null;
  }
}

/**
 * What a failed specialist was doing, as lines to append to its failure
 * message, or null when nothing is known. Never throws.
 */
export function buildPostMortem(agentGroupId: string, sessionId: string): string | null {
  try {
    const lines: string[] = [];
    const id = conversationId(agentGroupId, sessionId);
    const transcript = id ? transcriptPath(agentGroupId, id) : null;
    if (transcript) lines.push(...summariseTranscript(readTail(transcript)));
    const logLine = lastRunLogLine(agentGroupId, sessionId);
    if (logLine) lines.push(`• Last log line: ${logLine}`);
    return lines.length > 0 ? ['What the specialist was doing:', ...lines].join('\n') : null;
  } catch {
    return null;
  }
}
