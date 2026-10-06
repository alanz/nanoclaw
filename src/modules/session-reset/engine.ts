/**
 * Session reset and session summaries (specs/session-reset.allium).
 *
 * Observe: the current conversation id of each chat session in a reset group,
 *   read from outbound.db each tick and when a container exits. A new id
 *   starts a conversation; the one it replaces ended (cleared or rotated).
 * Reset: once a day at the reset time, a quiet session's conversation is
 *   ended and the next container start is asked for a fresh one.
 * Archive: every ended conversation's transcript → conversations/.
 * Summarise: a one-shot task per archive writes memory/sessions/; retried by
 *   later ticks, a failed placeholder after the last attempt.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { isContainerRunning } from '../../container-runner.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { heartbeatPath, withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalStamp } from '../../timezone.js';
import type { AgentGroup, Session } from '../../types.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import type { SessionResetConfig } from './config.js';
import {
  type ConversationRow,
  deleteReset,
  endConversation,
  getActiveConversation,
  getConversation,
  getLastCheckedOn,
  getOpenSummaries,
  getPendingReset,
  getUnarchivedConversations,
  insertConversation,
  insertPendingReset,
  markResetApplied,
  reactivateConversation,
  setArchived,
  setLastCheckedOn,
  setSummaryScheduled,
  setSummarySettled,
} from './db.js';
import { findTranscript, formatArchive, freeName, parseTranscript, readSessionActivity } from './transcript.js';

const SUPPORTED_PROVIDER = 'claude';

async function providerFor(session: Session): Promise<string> {
  return (await getContainerConfig(session.agent_group_id))?.provider ?? session.agent_provider ?? 'claude';
}

/** Is this session one the module looks after? */
export function isResetSession(session: Session, group: AgentGroup, config: SessionResetConfig): boolean {
  return config.groups.has(group.folder) && session.status === 'active' && session.messaging_group_id !== null;
}

/** The chat sessions of every reset group. */
export async function resetSessions(
  config: SessionResetConfig,
): Promise<Array<{ session: Session; group: AgentGroup }>> {
  const out: Array<{ session: Session; group: AgentGroup }> = [];
  for (const folder of config.groups) {
    const group = await getAgentGroupByFolder(folder);
    if (!group) continue;
    for (const session of await getSessionsByAgentGroup(group.id)) {
      if (isResetSession(session, group, config)) out.push({ session, group });
    }
  }
  return out;
}

// ── Observe ──────────────────────────────────────────────────────────────────

export async function observeSession(session: Session, now: Date): Promise<void> {
  const provider = await providerFor(session);
  if (provider !== SUPPORTED_PROVIDER) return;
  const activity = readSessionActivity(session.agent_group_id, session.id, provider);
  if (!activity) return;
  const current = activity.conversationId;
  const at = now.toISOString();

  // The runner drops the old id when it starts fresh; once it is gone the
  // reset has taken effect.
  const pending = await getPendingReset(session.id);
  if (pending && current !== pending.conversation_id) {
    await markResetApplied(session.id, pending.conversation_id, at);
    log.info('Session reset applied', { sessionId: session.id, conversationId: pending.conversation_id });
  }

  const active = await getActiveConversation(session.id);
  if (current) {
    if (await getConversation(session.id, current)) return;
    if (active) {
      const rotated = findTranscript(session.agent_group_id, active.conversation_id)?.rotated ?? false;
      await endConversation(session.id, active.conversation_id, rotated ? 'rotated' : 'cleared', at);
      log.info('Conversation ended', {
        sessionId: session.id,
        conversationId: active.conversation_id,
        reason: rotated ? 'rotated' : 'cleared',
      });
    }
    await insertConversation({
      session_id: session.id,
      conversation_id: current,
      agent_group_id: session.agent_group_id,
      first_seen_at: at,
    });
  } else if (active) {
    await endConversation(session.id, active.conversation_id, 'cleared', at);
    log.info('Conversation ended', {
      sessionId: session.id,
      conversationId: active.conversation_id,
      reason: 'cleared',
    });
  }
}

// ── Daily reset ──────────────────────────────────────────────────────────────

function lastActivityMs(session: Session, lastOutboundAt: string | null): number {
  const times = [session.last_active, lastOutboundAt].map((t) => (t ? Date.parse(t) : 0));
  try {
    times.push(fs.statSync(heartbeatPath(session.agent_group_id, session.id)).mtimeMs);
  } catch {
    // No heartbeat yet.
  }
  return Math.max(0, ...times.filter((t) => Number.isFinite(t)));
}

function containerRunning(session: Session): boolean {
  return isContainerRunning(session.id) || session.container_status === 'running';
}

/** Run the once-a-day reset decision for a session if it is due. */
export async function dailyResetCheck(session: Session, config: SessionResetConfig, now: Date): Promise<void> {
  const tz = await resolveGroupTimezone(session.agent_group_id);
  const stamp = formatLocalStamp(now, tz); // "YYYY-MM-DD HH:mm"
  const today = stamp.slice(0, 10);
  if (stamp.slice(11, 16) < config.resetTime) return;
  const lastChecked = await getLastCheckedOn(session.id);
  if (lastChecked === today) return;
  await setLastCheckedOn(session.id, today);
  // A session seen for the first time (or the module just installed) starts
  // counting from tomorrow: never reset at an arbitrary hour on deploy.
  if (lastChecked === undefined) return;

  const skip = (reason: string, extra: Record<string, unknown> = {}) =>
    log.info('Session reset skipped', { sessionId: session.id, reason, ...extra });

  const provider = await providerFor(session);
  if (provider !== SUPPORTED_PROVIDER) return skip('provider', { provider });
  if (containerRunning(session)) return skip('container running');
  const conversation = await getActiveConversation(session.id);
  if (!conversation) return skip('no conversation since the last reset');
  if (await getPendingReset(session.id)) return skip('reset already pending');
  const activity = readSessionActivity(session.agent_group_id, session.id, provider);
  const idleMs = now.getTime() - lastActivityMs(session, activity?.lastOutboundAt ?? null);
  if (idleMs < config.minIdleMs) return skip('active recently', { idleMinutes: Math.floor(idleMs / 60_000) });

  const at = now.toISOString();
  await insertPendingReset(session.id, conversation.conversation_id, at);
  await endConversation(session.id, conversation.conversation_id, 'reset', at);
  // A container that started between the checks above and the pending row
  // resumed the old conversation without seeing it: withdraw, try tomorrow.
  const fresh = await getSession(session.id);
  if (fresh && containerRunning(fresh)) {
    await deleteReset(session.id, conversation.conversation_id);
    await reactivateConversation(session.id, conversation.conversation_id);
    return skip('container started during reset');
  }
  log.info('Session reset requested', { sessionId: session.id, conversationId: conversation.conversation_id });
}

/**
 * Session contributor: while a reset is pending and the old conversation is
 * still the stored one, ask the runner to start fresh.
 */
export async function freshConversationEnv(session: Session): Promise<Record<string, string> | undefined> {
  const pending = await getPendingReset(session.id);
  if (!pending) return undefined;
  const provider = await providerFor(session);
  const current = readSessionActivity(session.agent_group_id, session.id, provider)?.conversationId ?? null;
  if (current === pending.conversation_id) return { NANOCLAW_FRESH_CONVERSATION: '1' };
  await markResetApplied(session.id, pending.conversation_id, new Date().toISOString());
  return undefined;
}

// ── Archive ──────────────────────────────────────────────────────────────────

function localFileStamp(now: Date, tz: string): string {
  const s = formatLocalStamp(now, tz); // "YYYY-MM-DD HH:mm"
  return `${s.slice(0, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}`;
}

export async function archiveEndedConversations(now: Date): Promise<void> {
  for (const row of await getUnarchivedConversations()) {
    const group = await getAgentGroup(row.agent_group_id);
    if (!group) continue;
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const tz = await resolveGroupTimezone(group.id);
    const stamp = localFileStamp(now, tz);
    const reason = row.end_reason ?? 'cleared';

    const location = findTranscript(group.id, row.conversation_id);
    let messages: ReturnType<typeof parseTranscript> = [];
    if (location) {
      try {
        messages = parseTranscript(fs.readFileSync(location.path, 'utf-8'));
      } catch (err) {
        log.warn('Session archive: transcript unreadable', { path: location.path, err });
      }
    }
    const placeholder = !location ? 'missing' : messages.length === 0 ? 'empty' : null;

    const conversationsDir = path.join(groupDir, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveName = freeName(conversationsDir, `${stamp}-${reason}${placeholder ? `-${placeholder}` : ''}`);
    const assistantName = (await getContainerConfig(group.id))?.assistant_name ?? group.name;
    fs.writeFileSync(
      path.join(conversationsDir, archiveName),
      formatArchive(
        {
          sessionId: row.session_id,
          conversationId: row.conversation_id,
          endReason: reason,
          archivedAt: now.toISOString(),
          transcript: location ? path.basename(location.path) : null,
        },
        messages,
        assistantName,
      ),
    );
    const archivePath = `conversations/${archiveName}`;

    if (placeholder) {
      // Nothing to summarise; the placeholder archive records that.
      await setArchived(row, archivePath, null);
      await setSummarySettled(row, 'failed', null);
      log.warn('Session archive: no transcript content', {
        sessionId: row.session_id,
        conversationId: row.conversation_id,
        placeholder,
      });
      continue;
    }

    const sessionsDir = path.join(groupDir, 'memory', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const summaryTarget = `memory/sessions/${freeName(sessionsDir, stamp)}`;
    await setArchived(row, archivePath, summaryTarget);
    log.info('Conversation archived', {
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      archive: archivePath,
      messages: messages.length,
    });
  }
}

// ── Summarise ────────────────────────────────────────────────────────────────

export function summaryPrompt(row: ConversationRow, config: SessionResetConfig): string {
  return [
    `Write the summary of one finished conversation. Do not message the user; your reply text goes only to this task's log.`,
    ``,
    `1. Read the conversation archive at /workspace/agent/${row.archive_path}.`,
    `2. Write the summary to /workspace/agent/${row.summary_target}. Start it with this frontmatter:`,
    `   ---`,
    `   type: session-summary`,
    `   session: ${row.session_id}`,
    `   conversation_id: ${row.conversation_id}`,
    `   archive: ../../${row.archive_path}`,
    `   created: <today's date, YYYY-MM-DD>`,
    `   ---`,
    `   Then these sections, concise and specific, each only if it has content:`,
    `   ## Summary (what the conversation was about, 3-6 sentences)`,
    `   ## Decisions`,
    `   ## Facts learned`,
    `   ## Open questions`,
    `   ## Tasks completed / started`,
    `   Link notes, reports and files the conversation produced with relative links from the summary's folder.`,
    `3. Update /workspace/agent/memory/sessions/index.md (create it if missing, starting with a "# Recent sessions" heading):`,
    `   add one line at the top of the list — "- [<date> <one-line gist>](<summary file name>)" —`,
    `   and keep only the newest ${config.sessionsIndexEntries} lines.`,
    `4. Stop. Do not edit any other file.`,
  ].join('\n');
}

async function summaryTaskFinished(row: ConversationRow): Promise<boolean> {
  if (!row.summary_task_id || !row.summary_task_session_id) return true;
  const session = await getSession(row.summary_task_session_id);
  if (!session || session.status === 'closed') return true;
  const task = await withExistingMailboxSession(row.agent_group_id, row.summary_task_session_id, (mb) =>
    mb.getTask(row.summary_task_id!),
  );
  return !task || task.status !== 'pending';
}

async function notifyFailure(row: ConversationRow, placeholder: string): Promise<void> {
  try {
    const session = await getSession(row.session_id);
    if (!session?.messaging_group_id) return;
    const mg = await getMessagingGroup(session.messaging_group_id);
    const adapter = getDeliveryAdapter();
    if (!mg || !adapter) return;
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id ?? null,
      'text',
      `I couldn't write a summary of an earlier conversation after ${row.summary_attempts} attempts. ` +
        `The conversation is archived at ${row.archive_path}; a placeholder is at ${placeholder}.`,
      undefined,
      mg.instance,
    );
  } catch (err) {
    log.error('Session summary: failed to report a failed summary', { sessionId: row.session_id, err });
  }
}

export async function summarySweep(config: SessionResetConfig, now: Date): Promise<void> {
  for (const row of await getOpenSummaries()) {
    if (!row.summary_target) continue;
    const group = await getAgentGroup(row.agent_group_id);
    if (!group) continue;
    const groupDir = path.join(GROUPS_DIR, group.folder);

    if (row.summary_status === 'scheduled' && !(await summaryTaskFinished(row))) continue;

    if (fs.existsSync(path.join(groupDir, row.summary_target))) {
      await setSummarySettled(row, 'done', row.summary_target);
      log.info('Session summary written', { sessionId: row.session_id, summary: row.summary_target });
      continue;
    }

    if (row.summary_attempts >= config.maxSummaryAttempts) {
      const failedName = row.summary_target.replace(/\.md$/, '-failed.md');
      fs.writeFileSync(
        path.join(groupDir, failedName),
        [
          '---',
          'type: session-summary',
          `session: ${row.session_id}`,
          `conversation_id: ${row.conversation_id}`,
          `archive: ../../${row.archive_path}`,
          'status: failed',
          '---',
          '',
          `No summary could be written after ${row.summary_attempts} attempts.`,
          `The conversation is archived at [${row.archive_path}](../../${row.archive_path}).`,
          '',
        ].join('\n'),
      );
      await setSummarySettled(row, 'failed', failedName);
      log.warn('Session summary failed', { sessionId: row.session_id, attempts: row.summary_attempts });
      await notifyFailure(row, failedName);
      continue;
    }

    const tz = await resolveGroupTimezone(group.id);
    const prepared = prepareScheduledTask({
      name: 'session-summary',
      prompt: summaryPrompt(row, config),
      processAfter: now.toISOString(),
      timezone: tz,
    });
    const { session, row: task } = await createScheduledTask(group.id, prepared);
    await setSummaryScheduled(row, task.id, session.id);
    log.info('Session summary scheduled', {
      sessionId: row.session_id,
      taskId: task.id,
      attempt: row.summary_attempts + 1,
    });
  }
}
