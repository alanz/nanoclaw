/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markAllPendingMessagesFailed,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  inboundDbPath,
  heartbeatPath,
  markSessionStuck,
} from './session-manager.js';
import {
  clearBootCrashState,
  getBootCrashState,
  isContainerRunning,
  killContainer,
  wakeOrQueue,
} from './container-runner.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

/**
 * Consecutive boot crashes before a session's queued work is declared
 * undeliverable. Matches the specialist threshold in specialists/recovery.ts:
 * one or two fast exits can be transient (image pull, host hiccup), a
 * sustained streak cannot.
 */
const BOOT_CRASH_THRESHOLD = 3;

/**
 * Give up on a session whose container cannot start, and tell the human.
 *
 * MAX_TRIES above only covers messages a container *claimed* and then died
 * holding. A container that dies during boot never claims anything, so that
 * path never engages: countDueMessages stays above zero, the wake respawns
 * once a tick, and the person who sent the message gets silence — for as long
 * as the fault persists. Specialists got a bounded failure in
 * specialists/recovery.ts; this is the same guarantee for everyone else.
 *
 * Returns true when it acted, so the caller skips the rest of the tick for
 * this session (notably the wake that would spawn container N+1).
 */
async function failSessionIfContainerCannotStart(
  inDb: Database.Database,
  session: Session,
  agentGroupName: string,
): Promise<boolean> {
  const crash = getBootCrashState(session.id);
  if (crash.count < BOOT_CRASH_THRESHOLD) return false;

  // Specialist sessions belong to the specialists recovery sweep, which fails
  // the *task* and routes the reason back to the requesting agent. Failing
  // their messages here would race that and strip the reporting.
  if (await isSpecialistSession(session)) return false;

  const reason = crash.stderrTail.at(-1) ?? 'no stderr captured';
  const failed = markAllPendingMessagesFailed(inDb);
  clearBootCrashState(session.id);

  log.error('Session container cannot start — failed queued messages', {
    sessionId: session.id,
    agentGroup: agentGroupName,
    consecutiveCrashes: crash.count,
    failedMessages: failed,
    stderrTail: crash.stderrTail,
  });

  await notifyChannelOfStartupFailure(session, reason);
  return true;
}

/** True when this session belongs to a specialist agent group. */
async function isSpecialistSession(session: Session): Promise<boolean> {
  try {
    const { getSpecialist } = await import('./modules/specialists/db.js');
    return !!getSpecialist(session.agent_group_id);
  } catch {
    // Specialists module absent or its table not yet migrated — not one.
    return false;
  }
}

/**
 * Tell the originating chat that its message will not be answered.
 *
 * The container is the only writer of outbound.db, so a container that never
 * starts cannot apologise for itself — the host has to send this directly
 * through the delivery adapter. Sessions with no messaging group (system task
 * sessions, agent_shared inboxes) have no one to tell; the log above is the
 * only report for those.
 */
async function notifyChannelOfStartupFailure(session: Session, reason: string): Promise<void> {
  if (!session.messaging_group_id) return;
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) return;

  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id,
      'chat',
      JSON.stringify({
        text:
          `I could not start — my container failed to boot ${BOOT_CRASH_THRESHOLD} times in a row, ` +
          `so your message was not processed. Last error: ${reason}`,
      }),
    );
  } catch (err) {
    // Best-effort: the failure is already recorded at error level above.
    log.warn('Could not notify channel of container startup failure', { sessionId: session.id, err });
  }
}

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number; idle: boolean }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      // Two very different situations reach this line, and only one is a fault.
      //
      // Idle: the container finished its conversation and the agent-runner is
      // parked in an open SDK query awaiting the next message (it deliberately
      // does not close the stream on silence — see the comment block in
      // container/agent-runner/src/poll-loop.ts). No SDK events arrive while
      // silent, so nothing touches the heartbeat and it ages out. Reaping it is
      // the intended lifecycle: the next inbound spawns a fresh container that
      // resumes the same session from its persisted continuation.
      //
      // Stuck: a claimed message or an in-flight tool is outstanding, so work
      // was owed and the container went silent holding it. That is a fault and
      // costs someone an answer.
      //
      // Both get killed the same way; they must not read the same way in logs,
      // or a real hang hides among the routine reaps.
      const idle = claims.length === 0 && !containerState?.current_tool;
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling, idle };
    }
  }

  // No early-return here for heartbeatMtimeMs === 0. A fresh container that
  // has claimed a message but never written a heartbeat is genuinely stuck;
  // the claim-stuck check below handles it correctly because
  // `0 > claimedAt` (a positive epoch ms) is always false, so the heartbeat
  // freshness guard never skips the stuck check. If the container just spawned
  // and a stale ack from a previous crash is present, the container's startup
  // path (clearStaleProcessingAcks) deletes it from outbound.db before
  // claiming new work.
  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
    // MODULE-HOOK:specialists-recovery:start
    try {
      const { sweepSpecialistTasks } = await import('./modules/specialists/index.js');
      await sweepSpecialistTasks();
    } catch {
      // Table not yet created or module not loaded — skip silently
    }
    // MODULE-HOOK:specialists-recovery:end
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // Finalize any "Reject with reason…" holds whose reply window elapsed (admin
  // ghosted, or the host restarted mid-capture). Central-DB scan, once per tick
  // — not per session.
  // MODULE-HOOK:approvals-reason-sweep:start
  try {
    const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
    await sweepAwaitingReasonRejects();
  } catch (err) {
    log.error('Reject-with-reason sweep failed', { err });
  }
  // MODULE-HOOK:approvals-reason-sweep:end

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 1b. Give up on a container that cannot start. Ordered BEFORE the wake:
    // once the streak is conclusive, spawning attempt N+1 only adds another
    // crash and another minute of silence for whoever is waiting.
    if (await failSessionIfContainerCannotStart(inDb, session, agentGroup.name)) return;

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    let justWoke = false;
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      await wakeOrQueue(session);
      justWoke = true;
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    // Skip on the same iteration that just woke the container — it hasn't
    // had a chance to clear stale processing_ack rows from a previous crash
    // yet. Without this grace period, stale claims cause an immediate
    // spawn-kill loop.
    if (alive && outDb && !justWoke) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end

    // 6. GC spent task sessions. An isolated per-task session with no live task
    // rows left (one-shot fired, or all cancelled/deleted) and no container
    // running is dead — close it so it stops being swept and listed. Runs after
    // recurrence so a just-fired recurring series has already re-armed its next
    // pending row and is never collected. The per-task log file in the workspace
    // is the durable history and survives the close.
    if (isTaskThread(session.thread_id)) {
      const liveTasks = (
        inDb
          .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
          .get() as { c: number }
      ).c;
      if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
        updateSession(session.id, { status: 'closed' });
        log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
      }
    }
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    if (decision.idle) {
      log.info('Reaping idle container', {
        sessionId: session.id,
        idleMs: decision.heartbeatAgeMs,
        ceilingMs: decision.ceilingMs,
      });
    } else {
      log.warn('Killing container past absolute ceiling — work outstanding', {
        sessionId: session.id,
        heartbeatAgeMs: decision.heartbeatAgeMs,
        ceilingMs: decision.ceilingMs,
      });
    }
    markSessionStuck(session.id);
    killContainer(session.id, decision.idle ? 'idle-ceiling' : 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  markSessionStuck(session.id);
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
    // Stale processing_ack rows in outbound.db are cleaned by the container
    // itself via clearStaleProcessingAcks() on startup — no host write needed.
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
