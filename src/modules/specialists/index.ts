/**
 * Specialists module — host-side wiring.
 *
 * Registers three delivery actions (system actions written by agent
 * containers to their outbound DB and picked up by the host delivery loop):
 *
 *   dispatch_specialist     — main group requests a root specialist task
 *   dispatch_sub_task       — specialist delegates to another specialist
 *   deliver_specialist_result — specialist delivers its final answer
 *
 * Also exports sweepSpecialistTasks() for use by host-sweep.ts.
 */
import { registerSessionContributor, registerSessionExitHook } from '../../container-runner.js';
import { deliverSessionMessages, registerDeliveryAction } from '../../delivery.js';
import { getSession } from '../../db/sessions.js';
import { unguarded } from '../../guard/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerBootCrashExemption } from '../boot-crash/index.js';
import { registerMemoryGroupExclusion } from '../../memory/manager.js';
import { getSpecialist, getTask } from './db.js';
import './group-delete.js';
import { handleDispatchSpecialist, handleDispatchSubTask } from './dispatch.js';
import { handleDeliverSpecialistResult } from './delivery.js';
import { buildInvocationForSession, endInvocationById } from './invocation.js';
import { sweepSpecialistTasks } from './recovery.js';

// Internal specialist orchestration between the operator's own agent groups —
// dispatch/sub-task/result routing is not externally reachable and ran
// unguarded before the delivery-action guard system existed. Keep it unguarded
// so specialists can delegate autonomously without approval deadlock.
registerDeliveryAction(
  'dispatch_specialist',
  handleDispatchSpecialist,
  unguarded('internal specialist orchestration; not externally reachable'),
);
registerDeliveryAction(
  'dispatch_sub_task',
  handleDispatchSubTask,
  unguarded('internal specialist-to-specialist delegation; not externally reachable'),
);
registerDeliveryAction(
  'deliver_specialist_result',
  handleDeliverSpecialistResult,
  unguarded('internal specialist result delivery; not externally reachable'),
);

/**
 * Specialist groups are ephemeral workers. Their memory/ is scratch space, so
 * indexing it burns embedding quota on content nobody searches. Declared here
 * rather than checked inside memory, so a search feature never has to know
 * what a specialist is.
 */
const specialistGroups = new Set<string>();

onHostStart(async () => {
  // Warm the set once; membership is fixed for an install's lifetime, and the
  // exclusion check runs on a path that must stay synchronous.
  const { getDb } = await import('../../db/index.js');
  const rows = await getDb().all<{ agent_group_id: string }>('SELECT agent_group_id FROM specialists');
  for (const row of rows) specialistGroups.add(row.agent_group_id);
});

registerMemoryGroupExclusion((groupId) => specialistGroups.has(groupId));

/**
 * Recovery tick.
 *
 * Matches the host sweep's cadence but runs on its own timer rather than
 * inside it: a specialist task can outlive the session that requested it, and
 * hanging this off the per-session sweep would tie a task-level concern to
 * whichever sessions happen to be live. Unref'd so it never holds the process
 * open on its own.
 */
const SPECIALIST_SWEEP_INTERVAL_MS = 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

onHostStart(() => {
  sweepTimer = setInterval(() => {
    void sweepSpecialistTasks().catch((err) => log.error('Specialist recovery sweep failed', { err }));
  }, SPECIALIST_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
});

onHostShutdown(() => {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
});

/**
 * A specialist's crash loop belongs to the recovery sweep, which fails the
 * TASK and routes the reason back to the agent that asked for it. The generic
 * boot-crash bound would end the session's messages first and strip that
 * reporting, so it stands down for sessions this module owns.
 */
registerBootCrashExemption(async (sessionId) => {
  const { getSession } = await import('../../db/sessions.js');
  const session = await getSession(sessionId);
  if (!session) return false;
  return (await getSpecialist(session.agent_group_id)) !== undefined;
});

/**
 * File handover rides a per-container "invocation": fresh ipc-out (rw) and
 * ipc-in (ro) dirs mounted into every session, and an `invocations` row that
 * `deliver_specialist_result` resolves them through. Every session, not only
 * specialists — a requester receives staged files through its own ipc-in.
 * Without the row, a specialist's result arrives as text and its files are
 * silently dropped.
 *
 * Ended by id when the container exits, so an exit cannot close a later
 * container's invocation. `buildInvocationForSession` also ends any orphan
 * it finds, as a backstop for an exit that never reported.
 */
const activeInvocations = new Map<string, string>();

registerSessionContributor(async ({ session }) => {
  const built = await buildInvocationForSession(session);
  if (!built) return undefined;
  activeInvocations.set(session.id, built.invocationId);
  return { mounts: built.mounts };
});

/**
 * A specialist group's folder is a template every task of that type shares,
 * concurrently: mounted writable, one task could change the instructions or
 * files the next task starts from. So it is read-only, and per-task state
 * lives in the session (and ipc-out) instead.
 *
 * NANOCLAW_SPECIALIST lets the runner honour "exit after this turn" from
 * dispatch_sub_task and deliver_specialist_result, which frees the container's
 * concurrency slot instead of holding it while the child runs or after the
 * task is done.
 *
 * A task starts from a clean conversation when it first starts (queued) or is
 * restarted (awaiting_restart): a restarted task is sent its prompt again, and
 * resuming the failed attempt's conversation as well would hand it the task
 * twice. A task woken while running — a sub-task's result routed back, which
 * sets the parent running before it wakes it — resumes, so the result lands in
 * the conversation that asked for it.
 */
registerSessionContributor(async ({ agentGroup, session }) => {
  if (!(await getSpecialist(agentGroup.id))) return undefined;
  const task = session.thread_id ? await getTask(session.thread_id) : undefined;
  const fresh = !task || task.status === 'queued' || task.status === 'awaiting_restart';
  return {
    readonlyWorkspace: true,
    env: { NANOCLAW_SPECIALIST: '1', ...(fresh ? { NANOCLAW_FRESH_CONVERSATION: '1' } : {}) },
  };
});

/**
 * Handle what the container left in outbound.db BEFORE ending its invocation.
 * A specialist exits right after dispatch_sub_task / deliver_specialist_result,
 * and the 1s delivery poll only covers sessions with a running container — so
 * without this its final system action would wait for the 60s sweep. Two
 * things go wrong in that gap: the task still reads `running` with no
 * container, which recovery takes for a crash; and ending the invocation
 * clears ipc-out before deliver_specialist_result has taken its files.
 */
registerSessionExitHook(({ sessionId }) => {
  const invocationId = activeInvocations.get(sessionId);
  if (!invocationId) return;
  activeInvocations.delete(sessionId);
  void (async () => {
    try {
      const session = await getSession(sessionId);
      if (session) await deliverSessionMessages(session);
    } catch (err) {
      log.warn('specialists: final outbound drain failed', { sessionId, err });
    }
    await endInvocationById(invocationId);
  })().catch((err) => log.warn('specialists: invocation cleanup failed', { sessionId, invocationId, err }));
});

export { sweepSpecialistTasks };
export { createSpecialist, setMainGroup } from './db.js';
