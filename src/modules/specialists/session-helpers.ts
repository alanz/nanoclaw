import fs from 'fs';

import { getNullMessagingGroupId } from '../../channels/null-channel.js';
import { killContainer, isContainerRunning } from '../../container-runner.js';
import { createSession, updateSession } from '../../db/sessions.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';

/**
 * Find an active session for a specific agent group and thread_id.
 * Used for specialist task sessions where thread_id = task.id.
 * Does not filter on messaging_group_id — the null-channel singleton id
 * suffices for new sessions, but existing rows may predate the singleton.
 */
export function findSessionByAgentGroupAndThread(agentGroupId: string, threadId: string): Session | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE agent_group_id = ? AND thread_id = ? AND status = 'active'
       LIMIT 1`,
    )
    .get(agentGroupId, threadId) as Session | undefined;
}

/**
 * Close a specialist session once its task reaches a terminal state (completed
 * or failed). Marks the session inactive in the central DB so the host sweep
 * stops treating it as live, and marks any still-pending inbound messages as
 * failed so they don't get re-queued on the next sweep tick.
 *
 * Matches v1 behaviour: specialists.ts `failSpecialistTask` /
 * `deliverResult` both called `updateSpecialistSession(taskId, { status: 'cleared' })`.
 */
export function closeSpecialistSession(session: Session): void {
  updateSession(session.id, { status: 'closed' });
  if (isContainerRunning(session.id)) {
    killContainer(session.id, 'task-complete');
  }
  const inPath = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(inPath)) return;
  const inDb = openInboundDb(session.agent_group_id, session.id);
  try {
    inDb.prepare("UPDATE messages_in SET status = 'failed' WHERE status = 'pending'").run();
  } catch (err) {
    log.warn('specialists: failed to mark pending inbound messages failed on session close', {
      sessionId: session.id,
      err,
    });
  } finally {
    inDb.close();
  }
}

export function createSpecialistSession(agentGroupId: string, taskId: string): Session {
  const id = `sess-spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: getNullMessagingGroupId(),
    thread_id: taskId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now,
    created_at: now,
  };
  createSession(session);
  return session;
}
