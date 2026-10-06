import { getDb } from '../../db/connection.js';
// The module owns these tables, so it owns registering their migration.
import '../../db/migrations/module-session-reset.js';

export type ConversationStatus = 'active' | 'ended';
export type EndReason = 'reset' | 'cleared' | 'rotated';
export type SummaryStatus = 'not_started' | 'scheduled' | 'done' | 'failed';

export interface ConversationRow {
  session_id: string;
  conversation_id: string;
  agent_group_id: string;
  status: ConversationStatus;
  end_reason: EndReason | null;
  first_seen_at: string;
  ended_at: string | null;
  archive_path: string | null;
  summary_status: SummaryStatus;
  summary_attempts: number;
  summary_target: string | null;
  summary_task_id: string | null;
  summary_task_session_id: string | null;
  summary_path: string | null;
}

export interface ResetRow {
  session_id: string;
  conversation_id: string;
  requested_at: string;
  status: 'pending' | 'applied';
  applied_at: string | null;
}

// ── Conversations ────────────────────────────────────────────────────────────

export async function getConversation(sessionId: string, conversationId: string): Promise<ConversationRow | undefined> {
  return getDb().get<ConversationRow>(
    'SELECT * FROM session_conversations WHERE session_id = ? AND conversation_id = ?',
    sessionId,
    conversationId,
  );
}

export async function getActiveConversation(sessionId: string): Promise<ConversationRow | undefined> {
  return getDb().get<ConversationRow>(
    "SELECT * FROM session_conversations WHERE session_id = ? AND status = 'active'",
    sessionId,
  );
}

export async function insertConversation(row: {
  session_id: string;
  conversation_id: string;
  agent_group_id: string;
  first_seen_at: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO session_conversations (session_id, conversation_id, agent_group_id, status, first_seen_at)
     VALUES (@session_id, @conversation_id, @agent_group_id, 'active', @first_seen_at)`,
    row,
  );
}

export async function endConversation(
  sessionId: string,
  conversationId: string,
  reason: EndReason,
  at: string,
): Promise<void> {
  await getDb().run(
    `UPDATE session_conversations SET status = 'ended', end_reason = ?, ended_at = ?
     WHERE session_id = ? AND conversation_id = ? AND status = 'active'`,
    reason,
    at,
    sessionId,
    conversationId,
  );
}

/** Ended conversations still owed an archive. */
export async function getUnarchivedConversations(): Promise<ConversationRow[]> {
  return getDb().all<ConversationRow>(
    "SELECT * FROM session_conversations WHERE status = 'ended' AND archive_path IS NULL ORDER BY ended_at",
  );
}

export async function setArchived(
  row: ConversationRow,
  archivePath: string,
  summaryTarget: string | null,
): Promise<void> {
  await getDb().run(
    `UPDATE session_conversations SET archive_path = ?, summary_target = ?
     WHERE session_id = ? AND conversation_id = ?`,
    archivePath,
    summaryTarget,
    row.session_id,
    row.conversation_id,
  );
}

/** Archived conversations whose summary is not settled yet. */
export async function getOpenSummaries(): Promise<ConversationRow[]> {
  return getDb().all<ConversationRow>(
    `SELECT * FROM session_conversations
     WHERE archive_path IS NOT NULL AND summary_status IN ('not_started', 'scheduled')
     ORDER BY ended_at`,
  );
}

export async function setSummaryScheduled(row: ConversationRow, taskId: string, taskSessionId: string): Promise<void> {
  await getDb().run(
    `UPDATE session_conversations
     SET summary_status = 'scheduled', summary_attempts = summary_attempts + 1,
         summary_task_id = ?, summary_task_session_id = ?
     WHERE session_id = ? AND conversation_id = ?`,
    taskId,
    taskSessionId,
    row.session_id,
    row.conversation_id,
  );
}

export async function setSummarySettled(
  row: ConversationRow,
  status: 'done' | 'failed',
  summaryPath: string | null,
): Promise<void> {
  await getDb().run(
    `UPDATE session_conversations SET summary_status = ?, summary_path = ?
     WHERE session_id = ? AND conversation_id = ?`,
    status,
    summaryPath,
    row.session_id,
    row.conversation_id,
  );
}

// ── Resets ───────────────────────────────────────────────────────────────────

export async function getPendingReset(sessionId: string): Promise<ResetRow | undefined> {
  return getDb().get<ResetRow>("SELECT * FROM session_resets WHERE session_id = ? AND status = 'pending'", sessionId);
}

export async function insertPendingReset(sessionId: string, conversationId: string, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO session_resets (session_id, conversation_id, requested_at, status)
     VALUES (?, ?, ?, 'pending')`,
    sessionId,
    conversationId,
    at,
  );
}

export async function deleteReset(sessionId: string, conversationId: string): Promise<void> {
  await getDb().run(
    'DELETE FROM session_resets WHERE session_id = ? AND conversation_id = ?',
    sessionId,
    conversationId,
  );
}

export async function markResetApplied(sessionId: string, conversationId: string, at: string): Promise<void> {
  await getDb().run(
    `UPDATE session_resets SET status = 'applied', applied_at = ?
     WHERE session_id = ? AND conversation_id = ? AND status = 'pending'`,
    at,
    sessionId,
    conversationId,
  );
}

/** Reopen a conversation whose reset was withdrawn before it took effect. */
export async function reactivateConversation(sessionId: string, conversationId: string): Promise<void> {
  await getDb().run(
    `UPDATE session_conversations SET status = 'active', end_reason = NULL, ended_at = NULL
     WHERE session_id = ? AND conversation_id = ? AND archive_path IS NULL`,
    sessionId,
    conversationId,
  );
}

// ── Daily checks ─────────────────────────────────────────────────────────────

export async function getLastCheckedOn(sessionId: string): Promise<string | undefined> {
  const row = await getDb().get<{ last_checked_on: string }>(
    'SELECT last_checked_on FROM session_reset_checks WHERE session_id = ?',
    sessionId,
  );
  return row?.last_checked_on;
}

export async function setLastCheckedOn(sessionId: string, localDate: string): Promise<void> {
  await getDb().run(
    `INSERT INTO session_reset_checks (session_id, last_checked_on) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_checked_on = excluded.last_checked_on`,
    sessionId,
    localDate,
  );
}
