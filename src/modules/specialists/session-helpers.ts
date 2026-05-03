import { getNullMessagingGroupId } from '../../channels/null-channel.js';
import { createSession } from '../../db/sessions.js';
import { getDb } from '../../db/connection.js';
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
