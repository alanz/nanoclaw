/**
 * Container concurrency cap and FIFO waiting queue.
 *
 * Every session wants a container and every container wants a VM's worth of
 * memory. Without a bound, a burst of inbound messages across many agent
 * groups spawns one container per session simultaneously and the host swaps
 * itself to death — the failure is not a crash but a machine that stops
 * answering, including for the sessions that were already healthy.
 *
 * So non-main sessions run under a cap and queue in arrival order when it is
 * full. The main group is exempt: it is the operator's own line, and an
 * assistant that stops answering because six of its own background agents are
 * busy is worse than one that occasionally overcommits by one container.
 *
 * Two seams carry it, both trunk-owned:
 *   - `setWakeGate` decides, in the one place every wake passes through,
 *     whether this session may start now — and takes the slot back when an
 *     admitted wake fails before any container exists.
 *   - `registerSessionExitHook` releases the slot when a container ends and
 *     starts the next waiter.
 *
 * Neither the router nor any of the other wake callers knows this module
 * exists. Installing it is one appended import in the modules barrel.
 */
import {
  isContainerRunning,
  registerSessionExitHook,
  setWakeGate,
  wakeContainer,
  type SessionExitEvent,
} from '../../container-runner.js';
import { getDb } from '../../db/index.js';
import { getRunningSessions, getSession } from '../../db/sessions.js';
import { onHostStart } from '../../host-lifecycle.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

import './migration.js';

/**
 * How many non-main containers may run at once.
 *
 * Read once. A cap that could change under a running queue would let the
 * accounting and the limit disagree, and the symptom (slots that never free)
 * is far harder to read than a restart.
 */
export const MAX_CONCURRENT_CONTAINERS = (() => {
  const raw =
    process.env.MAX_CONCURRENT_CONTAINERS?.trim() ||
    readEnvFile(['MAX_CONCURRENT_CONTAINERS']).MAX_CONCURRENT_CONTAINERS?.trim() ||
    '';
  return Math.max(1, parseInt(raw || '5', 10) || 5);
})();

/**
 * Main-group membership, cached.
 *
 * The gate runs on every wake and the answer changes about once in an
 * install's lifetime, so a DB round trip per wake would be pure overhead on
 * the hot path. A miss costs one read; there is no invalidation because
 * promoting a different group to main is a deliberate act that comes with a
 * restart.
 */
const mainGroupCache = new Map<string, boolean>();

async function isMainGroup(agentGroupId: string): Promise<boolean> {
  const cached = mainGroupCache.get(agentGroupId);
  if (cached !== undefined) return cached;
  let value = false;
  try {
    const row = (await getDb().get('SELECT is_main FROM agent_groups WHERE id = ?', [agentGroupId])) as
      | { is_main: number }
      | undefined;
    value = row?.is_main === 1;
  } catch (err) {
    // An install whose column is missing (or a read that failed) is one where
    // nothing is main — the cap applies to everything, which is the safe way
    // to be wrong: it throttles, it never overcommits.
    log.debug('is_main lookup failed; treating group as non-main', { agentGroupId, err });
  }
  mainGroupCache.set(agentGroupId, value);
  return value;
}

interface WaitingEntry {
  session: Session;
  queuedAt: number;
}

/** Arrival-ordered. A cap that reordered would starve whoever queued first. */
const waitingQueue: WaitingEntry[] = [];

/**
 * Sessions holding a slot: running, or mid-spawn with the slot reserved.
 *
 * Reserved synchronously at admission rather than when the container reports
 * itself running — two wakes arriving in the same tick would otherwise both
 * see room and both spawn, and the cap would be advisory.
 */
const activeNonMainSessions = new Set<string>();

async function admit(session: Session): Promise<boolean> {
  if (await isMainGroup(session.agent_group_id)) return true;

  // Re-entry: a dequeued session passes back through the gate, and it already
  // holds the slot that let it be dequeued.
  if (activeNonMainSessions.has(session.id)) return true;

  if (activeNonMainSessions.size < MAX_CONCURRENT_CONTAINERS) {
    activeNonMainSessions.add(session.id);
    return true;
  }

  if (waitingQueue.some((w) => w.session.id === session.id)) {
    log.debug('Session already in waiting queue', { sessionId: session.id });
    return false;
  }

  waitingQueue.push({ session, queuedAt: Date.now() });
  log.info('Session queued (concurrency cap reached)', {
    sessionId: session.id,
    agentGroup: session.agent_group_id,
    queuePos: waitingQueue.length,
    activeNonMain: activeNonMainSessions.size,
    cap: MAX_CONCURRENT_CONTAINERS,
  });
  return false;
}

function releaseAndDrain(event: SessionExitEvent): void {
  release(event.sessionId);
}

/**
 * Give a slot back and start the next waiter. Idempotent: a session that
 * holds no slot (main group, already released) is a no-op, which is what lets
 * the exit hook and the wake gate's release both fire for one wake.
 */
function release(sessionId: string): void {
  if (!activeNonMainSessions.delete(sessionId)) return;
  drainWaiting();
}

function drainWaiting(): void {
  while (waitingQueue.length > 0 && activeNonMainSessions.size < MAX_CONCURRENT_CONTAINERS) {
    const next = waitingQueue.shift()!;
    activeNonMainSessions.add(next.session.id);
    log.info('Dequeuing waiting session', {
      sessionId: next.session.id,
      agentGroup: next.session.agent_group_id,
      waitedMs: Date.now() - next.queuedAt,
    });
    // A wake that fails to spawn must not hold the slot it was given, or the
    // cap leaks a slot per failure until nothing can start at all.
    const handBack = (): void => {
      activeNonMainSessions.delete(next.session.id);
      drainWaiting();
    };
    void wakeIfStillActive(next.session).then((ok) => {
      if (!ok) handBack();
    }, handBack);
  }
}

/**
 * Wake a dequeued session — unless it was closed while it waited (a finished
 * specialist task, a closed thread). The queue holds the Session as it was
 * when queued, and nothing on the way to a container re-reads its status, so
 * a closed session was spawned anyway and held the slot until the idle reap.
 * Wakes the fresh row, not the stale copy.
 */
async function wakeIfStillActive(queued: Session): Promise<boolean> {
  const fresh = await getSession(queued.id);
  if (!fresh || fresh.status !== 'active') {
    log.info('Dropping a queued session closed while it waited', { sessionId: queued.id });
    return false;
  }
  return wakeContainer(fresh);
}

/** Current cap state, for observability. */
export function getQueueStatus(): { activeNonMain: number; max: number; waiting: number } {
  return { activeNonMain: activeNonMainSessions.size, max: MAX_CONCURRENT_CONTAINERS, waiting: waitingQueue.length };
}

/** @internal Test seam — drop all queue and cache state. */
export function resetConcurrencyStateForTesting(): void {
  waitingQueue.length = 0;
  activeNonMainSessions.clear();
  mainGroupCache.clear();
}

/** @internal Test seam — the gate, so a suite can drive it without a wake. */
export const admitForTesting = admit;

/** @internal Test seam — the gate's release, as container-runner calls it for a wake that never started. */
export function releaseForTesting(session: Session): void {
  release(session.id);
}

/**
 * Count in the containers a host restart adopted.
 *
 * Containers that survive a restart are re-attached by adoptRunningSessions
 * without passing the wake gate, so the slot set started empty and the cap
 * admitted a full set of new containers on top of them — five adopted plus
 * five new against a cap of five. Adopted non-main sessions take their slots
 * here; their exit releases them like any other. If more were adopted than
 * the cap allows, new wakes queue until enough have exited.
 *
 * A host-start hook: those run after adoption (src/index.ts).
 */
export async function countAdoptedContainers(): Promise<number> {
  let counted = 0;
  for (const session of await getRunningSessions()) {
    if (!isContainerRunning(session.id)) continue;
    if (await isMainGroup(session.agent_group_id)) continue;
    if (activeNonMainSessions.has(session.id)) continue;
    activeNonMainSessions.add(session.id);
    counted++;
  }
  if (counted > 0) {
    log.info('Adopted containers counted against the concurrency cap', {
      counted,
      activeNonMain: activeNonMainSessions.size,
      cap: MAX_CONCURRENT_CONTAINERS,
    });
  }
  return counted;
}

// Two hand-backs, one per way a wake can end: the exit hook for a wake that
// registered a runtime, the gate's release for one that never did.
setWakeGate(admit, (session) => release(session.id));
registerSessionExitHook(releaseAndDrain);
onHostStart(async () => {
  await countAdoptedContainers();
});
