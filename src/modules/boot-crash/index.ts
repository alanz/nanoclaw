/**
 * Bounded failure for a container that cannot start.
 *
 * A container that dies during startup — before the agent-runner reaches its
 * poll loop — never claims a message, never writes to outbound.db, and never
 * touches the heartbeat. Every host-side stall detector keys off one of those
 * three signals, so a boot crash is invisible to all of them: `sweepSession`
 * walks `getProcessingClaims()`, and a container that never polled has no
 * claims to walk. The wake path just respawns on the next tick, forever.
 *
 * That is not hypothetical. A read-only-workspace bug crashed specialist
 * containers ~800ms into boot; the host respawned 241 times across 4 hours
 * until a global timeout finally fired, and the reason sat in the container's
 * stderr the whole time.
 *
 * The exit code alone cannot distinguish this from ordinary failure: a
 * container that ran real work and then exited non-zero is a different event
 * with a different remedy. The discriminator is lifetime — a non-zero exit
 * within BOOT_CRASH_WINDOW_MS of spawn means it died on the way up. Counting
 * those consecutively per session gives a signal a stalled-work detector
 * cannot produce, and any healthy exit clears it.
 *
 * On the threshold this ends the session's pending work and says why, using
 * the stderr tail the driver captured. Silence is the thing being fixed: the
 * person who sent the message is owed an answer, even when the answer is that
 * it cannot run.
 */
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { registerSessionExitHook, type SessionExitEvent } from '../../container-runner.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';

/**
 * A non-zero exit sooner than this means the container died on the way up
 * rather than after doing work. Generous: image pull and runtime start are
 * inside it on a cold host, and the cost of being wrong is one extra retry.
 */
const BOOT_CRASH_WINDOW_MS = 10_000;

/**
 * Consecutive boot crashes before a session's queued work is declared
 * undeliverable. One or two fast exits can be transient (image pull, host
 * hiccup); a sustained streak cannot.
 */
const BOOT_CRASH_THRESHOLD = 3;

interface BootCrashState {
  /** Consecutive fast non-zero exits. Reset by any healthy exit. */
  count: number;
  /** Stderr tail of the most recent crash — the actual reason, e.g. EROFS. */
  stderrTail: readonly string[];
}

const bootCrashes = new Map<string, BootCrashState>();

/**
 * Sessions whose crash loops belong to another owner.
 *
 * A specialist's crash loop is failed by the specialist recovery sweep, which
 * fails the TASK and routes the reason back to the agent that asked for it.
 * Ending its messages here would race that and strip the reporting. Rather
 * than teaching this module what a specialist is, the owner declares itself.
 */
type ExemptionCheck = (sessionId: string) => boolean | Promise<boolean>;
const exemptions: ExemptionCheck[] = [];

export function registerBootCrashExemption(check: ExemptionCheck): void {
  exemptions.push(check);
}

async function isExempt(sessionId: string): Promise<boolean> {
  for (const check of exemptions) {
    try {
      if (await check(sessionId)) return true;
    } catch (err) {
      log.error('Boot-crash exemption check threw', { sessionId, err });
    }
  }
  return false;
}

/** Consecutive boot crashes for a session, and the last crash's stderr tail. */
export function getBootCrashState(sessionId: string): { count: number; stderrTail: readonly string[] } {
  const state = bootCrashes.get(sessionId);
  return state ? { count: state.count, stderrTail: state.stderrTail } : { count: 0, stderrTail: [] };
}

/**
 * Clear boot-crash state. Call when the work's owner has acted on the loop, so
 * a later retry of the same session starts from a clean count rather than
 * tripping instantly.
 */
export function clearBootCrashState(sessionId: string): void {
  bootCrashes.delete(sessionId);
}

/** @internal Test seam. */
export function resetBootCrashStateForTesting(): void {
  bootCrashes.clear();
  exemptions.length = 0;
}

function record(event: SessionExitEvent): number {
  const exitCode = event.failure?.kind === 'started-then-died' ? event.failure.exitCode : undefined;
  const stderrTail = event.failure?.kind === 'started-then-died' ? (event.failure.stderrTail ?? []) : [];
  // A null/absent code means killed by signal (normal shutdown, task complete),
  // never a boot failure. A slow non-zero exit means real work ran first.
  const isBootCrash =
    typeof exitCode === 'number' && exitCode !== 0 && event.ranMs < BOOT_CRASH_WINDOW_MS && !event.adopted;
  if (!isBootCrash) {
    bootCrashes.delete(event.sessionId);
    return 0;
  }
  const count = (bootCrashes.get(event.sessionId)?.count ?? 0) + 1;
  bootCrashes.set(event.sessionId, { count, stderrTail });
  log.warn('Container died during startup', {
    sessionId: event.sessionId,
    consecutive: count,
    exitCode,
    stderrTail,
  });
  return count;
}

async function failSessionIfContainerCannotStart(sessionId: string): Promise<void> {
  const { stderrTail } = getBootCrashState(sessionId);
  if (await isExempt(sessionId)) return;

  const session = await getSession(sessionId);
  if (!session) return;

  let failed = 0;
  try {
    failed =
      (await withExistingMailboxSession(session.agent_group_id, sessionId, (mailbox) =>
        mailbox.failPendingMessages(),
      )) ?? 0;
  } catch (err) {
    log.error('Failed to end pending messages for a non-starting container', { sessionId, err });
    return;
  }
  clearBootCrashState(sessionId);

  const reason = stderrTail.at(-1) ?? 'no stderr captured';
  log.error('Session abandoned: container cannot start', {
    sessionId,
    agentGroupId: session.agent_group_id,
    failedMessages: failed,
    reason,
  });

  if (failed === 0) return;
  // Tell whoever was waiting. A bounded failure nobody hears about is still
  // silence from their side.
  try {
    // A session with no messaging group (a task or specialist lane) has no
    // one waiting on the other end to tell.
    if (!session.messaging_group_id) return;
    const mg = await getMessagingGroup(session.messaging_group_id);
    const adapter = getDeliveryAdapter();
    if (!mg || !adapter) return;
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id ?? null,
      'text',
      `I couldn't start up to handle that — the container failed ${BOOT_CRASH_THRESHOLD} times in a row.\n\n` +
        `Last error: ${reason}\n\n` +
        `${failed} pending message${failed === 1 ? '' : 's'} ${failed === 1 ? 'was' : 'were'} dropped. ` +
        `Check \`logs/nanoclaw.error.log\` for details.`,
      undefined,
      mg.instance,
    );
  } catch (err) {
    log.error('Failed to report a non-starting container', { sessionId, err });
  }
}

registerSessionExitHook((event) => {
  if (record(event) < BOOT_CRASH_THRESHOLD) return;
  void failSessionIfContainerCannotStart(event.sessionId);
});
