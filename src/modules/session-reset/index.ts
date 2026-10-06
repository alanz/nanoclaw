/**
 * Session reset + session summaries (specs/session-reset.allium,
 * docs/session-reset-design.md).
 *
 * Off unless SESSION_RESET_GROUPS names at least one agent group folder.
 * Host-only: the host reads outbound.db but never writes it; a reset reaches
 * the container as NANOCLAW_FRESH_CONVERSATION on its next start.
 */
import { registerSessionContributor, registerSessionExitHook } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { loadSessionResetConfig, type SessionResetConfig } from './config.js';
import {
  archiveEndedConversations,
  dailyResetCheck,
  freshConversationEnv,
  isResetSession,
  observeSession,
  resetSessions,
  summarySweep,
} from './engine.js';

const TICK_INTERVAL_MS = 60_000;

let config: SessionResetConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** One pass: observe, decide resets, archive, summarise. Never overlaps itself. */
export async function sessionResetTick(cfg: SessionResetConfig, now = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const { session } of await resetSessions(cfg)) {
      try {
        await observeSession(session, now);
        await dailyResetCheck(session, cfg, now);
      } catch (err) {
        log.error('Session reset: session pass failed', { sessionId: session.id, err });
      }
    }
    await archiveEndedConversations(now);
    await summarySweep(cfg, now);
  } finally {
    ticking = false;
  }
}

onHostStart(() => {
  config = loadSessionResetConfig();
  if (config.groups.size === 0) {
    log.info('Session reset disabled: SESSION_RESET_GROUPS not set');
    config = null;
    return;
  }
  const cfg = config;
  log.info('Session reset enabled', { groups: [...cfg.groups], time: cfg.resetTime });
  timer = setInterval(() => {
    void sessionResetTick(cfg).catch((err) => log.error('Session reset tick failed', { err }));
  }, TICK_INTERVAL_MS);
  timer.unref?.();
});

onHostShutdown(() => {
  if (timer) clearInterval(timer);
  timer = null;
});

// A container exit is the moment a /clear or a rotation is most likely to
// have just happened; catch it before the next spawn rather than a tick later.
registerSessionExitHook(({ sessionId }) => {
  const cfg = config;
  if (!cfg) return;
  void (async () => {
    const session = await getSession(sessionId);
    if (!session) return;
    const group = await getAgentGroup(session.agent_group_id);
    if (!group || !isResetSession(session, group, cfg)) return;
    await observeSession(session, new Date());
  })().catch((err) => log.error('Session reset: exit observation failed', { sessionId, err }));
});

registerSessionContributor(async ({ agentGroup, session }) => {
  const cfg = config;
  if (!cfg || !isResetSession(session, agentGroup, cfg)) return undefined;
  const env = await freshConversationEnv(session);
  if (!env) return undefined;
  log.info('Session reset: starting a fresh conversation', { sessionId: session.id });
  return { env };
});
