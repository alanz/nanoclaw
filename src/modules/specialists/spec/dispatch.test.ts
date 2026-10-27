/**
 * Propagated from specs/specialists.allium — dispatch and task lifecycle:
 * MainGroupDispatchesSpecialist, SpecialistTaskStarted, SpecialistBootFailed,
 * SpecialistDispatchesSubTask, SubTaskRejectedDepth / Count / SameTypeLimit,
 * MemoryProviderDispatched, and the SpecialistTask.status transition graph.
 *
 * Every test drives the real handlers (handleDispatchSpecialist,
 * handleDispatchSubTask, handleDeliverSpecialistResult, sweepSpecialistTasks)
 * and the real routing against a migrated test DB. Only the process and
 * container boundaries are faked: container liveness and wake, the session
 * mailbox writes, request-wake, boot-crash evidence and the null channel's
 * presence.
 *
 * rule-failure.<Rule>.<n> falsifies the n-th `requires` clause of that rule,
 * counted in order in the spec, with every other clause held true.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  writes: [] as Array<{ sessionId: string; id: string; text: string; trigger: boolean }>,
  woken: [] as string[],
  alive: new Set<string>(),
  bootCrashes: new Map<string, number>(),
  nullChannelPresent: true,
}));

vi.mock('../../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../container-runner.js')>()),
  wakeContainer: vi.fn(async (s: { id: string }) => {
    h.woken.push(s.id);
    return true;
  }),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn((id: string) => h.alive.has(id)),
}));
vi.mock('../../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session-manager.js')>()),
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(
    async (_ag: string, sessionId: string, msg: { id: string; content: string; trigger?: boolean }) => {
      h.writes.push({ sessionId, id: msg.id, text: JSON.parse(msg.content).text, trigger: Boolean(msg.trigger) });
    },
  ),
  withExistingMailboxSession: vi.fn(async () => undefined),
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../../channels/null-channel.js', () => ({
  NULL_CHANNEL_TYPE: 'null_channel',
  NULL_CHANNEL_PLATFORM_ID: 'specialist',
  getNullMessagingGroupId: async () => {
    if (!h.nullChannelPresent) throw new Error('Null channel MessagingGroup not found');
    return 'mg-null';
  },
}));
vi.mock('../../boot-crash/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../boot-crash/index.js')>()),
  getBootCrashState: vi.fn((id: string) => ({ count: h.bootCrashes.get(id) ?? 0, stderrTail: ['boom'] })),
  clearBootCrashState: vi.fn(),
}));

import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { createMessagingGroup } from '../../../db/messaging-groups.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createSession } from '../../../db/sessions.js';
import type { Session } from '../../../types.js';
import { SPECIALISTS_CONFIG } from '../config.js';
import { createSpecialist, createTask, getTask } from '../db.js';
import { handleDeliverSpecialistResult } from '../delivery.js';
import { handleDispatchSpecialist, handleDispatchSubTask } from '../dispatch.js';
import { sweepSpecialistTasks } from '../recovery.js';
import type { SpecialistTask } from '../types.js';
import { covered, divergence, obligation } from './harness.js';

const now = () => new Date().toISOString();
const MAX_DEPTH = SPECIALISTS_CONFIG.maxSpecialistDepth;
const MAX_CHAIN = SPECIALISTS_CONFIG.maxChainDelegations;
const MAX_SAME = SPECIALISTS_CONFIG.maxSameTypeDispatches;

// ── world ────────────────────────────────────────────────────────────────────

async function group(id: string, kind: 'plain' | 'specialist' | 'memory'): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  if (kind === 'plain') return;
  await createSpecialist({
    agent_group_id: id,
    is_memory_provider: kind === 'memory' ? 1 : 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
}

async function session(id: string, agentGroupId: string, threadId: string | null): Promise<Session> {
  const s = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  } as const;
  await createSession(s);
  return s as unknown as Session;
}

async function task(fields: Partial<SpecialistTask> & { id: string; specialist_group_id: string }): Promise<void> {
  await createTask({
    prompt: 'do work',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
    ...fields,
  });
}

/**
 * A task "task-parent" of `group`, with its own session "sess-parent". The
 * default is a running depth-1 task one level below ag-b, so an accepted
 * dispatch is the outcome unless a test changes something.
 */
async function parent(
  opts: {
    group?: string;
    status?: SpecialistTask['status'];
    depth?: number;
    chain?: number;
    ancestors?: string[];
  } = {},
): Promise<Session> {
  const ancestors = opts.ancestors ?? (opts.depth === undefined ? ['ag-b'] : chainOf(opts.depth));
  const g = opts.group ?? 'ag-a';
  const s = await session('sess-parent', g, 'task-parent');
  await task({
    id: 'task-parent',
    specialist_group_id: g,
    status: opts.status === 'awaiting_sub_task' ? 'running' : (opts.status ?? 'running'),
    depth: ancestors.length,
    chain_delegation_count: opts.chain ?? ancestors.length + 1,
    ancestor_group_ids: JSON.stringify(ancestors),
  });
  if (opts.status === 'awaiting_sub_task') {
    await task({
      id: 'task-pending',
      specialist_group_id: 'ag-b',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      status: 'running',
    });
    await getDb().run(
      "UPDATE specialist_tasks SET status = 'awaiting_sub_task', pending_sub_task_id = 'task-pending' WHERE id = 'task-parent'",
    );
  }
  return s;
}

function chainOf(depth: number): string[] {
  return Array.from({ length: depth }, (_, i) => (i % 2 === 0 ? 'ag-b' : 'ag-a'));
}

/** Earlier sub-tasks of task-parent into `target`, already finished. */
async function priorChildren(target: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await task({
      id: `task-prior-${i}`,
      specialist_group_id: target,
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      status: 'completed',
      result: 'earlier',
      closed_at: now(),
    });
  }
}

const allTasks = () => getDb().all<SpecialistTask>('SELECT * FROM specialist_tasks');
const taskCount = async () => (await allTasks()).length;
const sessionCount = async () => ((await getDb().get('SELECT COUNT(*) AS n FROM sessions')) as { n: number }).n;
const taskSession = (taskId: string) => getDb().get<Session>('SELECT * FROM sessions WHERE thread_id = ?', taskId);
const told = (sessionId: string) => h.writes.filter((w) => w.sessionId === sessionId).map((w) => w.text);

/** Tasks created by `fn`. */
async function created(fn: () => Promise<void>): Promise<SpecialistTask[]> {
  const before = new Set((await allTasks()).map((t) => t.id));
  await fn();
  return (await allTasks()).filter((t) => !before.has(t.id));
}

const dispatchSub = (s: Session, target: string, prompt = 'sub work') =>
  handleDispatchSubTask({ specialist_group_id: target, prompt }, s);

const parentTask = async () => (await getTask('task-parent'))!;

/** Nothing of SpecialistDispatchesSubTask happened: no queued child, parent not suspended. */
async function noAcceptedSubTask(made: SpecialistTask[], parentStatus: SpecialistTask['status']): Promise<void> {
  expect(made.filter((t) => t.status === 'queued')).toEqual([]);
  const p = await getTask('task-parent');
  if (p) {
    expect(p.status).toBe(parentStatus);
    if (parentStatus !== 'awaiting_sub_task') expect(p.pending_sub_task_id).toBeNull();
    else expect(p.pending_sub_task_id).toBe('task-pending');
  }
  expect(h.woken).toEqual([]);
}

beforeEach(async () => {
  h.writes.length = 0;
  h.woken.length = 0;
  h.alive.clear();
  h.bootCrashes.clear();
  h.nullChannelPresent = true;
  await runMigrations(await initTestDb());
  await createMessagingGroup({
    id: 'mg-null',
    channel_type: 'null_channel',
    platform_id: 'specialist',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await group('ag-main', 'plain');
  await getDb().run('UPDATE agent_groups SET is_main = 1 WHERE id = ?', 'ag-main');
  await group('ag-other', 'plain');
  await group('ag-plain', 'plain');
  await group('ag-a', 'specialist');
  await group('ag-b', 'specialist');
  await group('ag-mem', 'memory');
  await session('sess-main', 'ag-main', null);
});
afterEach(async () => {
  await closeDb();
});

// ── MainGroupDispatchesSpecialist ────────────────────────────────────────────

describe('MainGroupDispatchesSpecialist', () => {
  obligation('rule-success.MainGroupDispatchesSpecialist', async () => {
    const main = (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'sess-main'"))!;
    const made = await created(() =>
      handleDispatchSpecialist({ specialist_group_id: 'ag-a', prompt: 'research X' }, main),
    );

    expect(made).toHaveLength(1);
    const t = made[0];
    expect(t.status).toBe('queued');
    // The per-task session: the specialist's group, on the null channel, keyed on the task.
    const s = (await taskSession(t.id))!;
    expect(s).toMatchObject({
      agent_group_id: 'ag-a',
      messaging_group_id: 'mg-null',
      thread_id: t.id,
      status: 'active',
    });
    expect(s.processing_state).toBe('idle');
    // The prompt is its triggering message, and the session is woken.
    expect(h.writes.filter((w) => w.sessionId === s.id)).toEqual([
      expect.objectContaining({ text: 'research X', trigger: true }),
    ]);
    expect(h.woken).toEqual([s.id]);
    // The dispatcher gets only a context note (guidance): no trigger.
    const notes = h.writes.filter((w) => w.sessionId === 'sess-main');
    expect(notes).toHaveLength(1);
    expect(notes[0].trigger).toBe(false);
    expect(notes[0].text).toContain(t.id);
  });

  obligation('rule-failure.MainGroupDispatchesSpecialist.1', async () => {
    const other = await session('sess-other', 'ag-other', null);
    const made = await created(() => handleDispatchSpecialist({ specialist_group_id: 'ag-a', prompt: 'p' }, other));
    expect(made).toEqual([]);
    expect(h.woken).toEqual([]);
    expect(told('sess-other').join('\n')).toContain('dispatch_specialist failed');
  });

  obligation('rule-failure.MainGroupDispatchesSpecialist.2', async () => {
    const main = (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'sess-main'"))!;
    const made = await created(() => handleDispatchSpecialist({ specialist_group_id: 'ag-nope', prompt: 'p' }, main));
    expect(made).toEqual([]);
    expect(h.woken).toEqual([]);
    expect(told('sess-main').join('\n')).toContain('dispatch_specialist failed');
  });

  obligation('rule-failure.MainGroupDispatchesSpecialist.3', async () => {
    const main = (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'sess-main'"))!;
    const made = await created(() => handleDispatchSpecialist({ specialist_group_id: 'ag-plain', prompt: 'p' }, main));
    expect(made).toEqual([]);
    expect(h.woken).toEqual([]);
    expect(told('sess-main').join('\n')).toContain('is not a specialist');
  });

  covered(
    'rule-failure.MainGroupDispatchesSpecialist.4',
    'src/modules/specialists/dispatch-null-channel.test.ts',
    'creates no root task and tells the main agent',
  );

  obligation('rule-entity-creation.MainGroupDispatchesSpecialist.1', async () => {
    const main = (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'sess-main'"))!;
    const t0 = now();
    const [t] = await created(() =>
      handleDispatchSpecialist({ specialist_group_id: 'ag-b', prompt: 'look it up' }, main),
    );
    const t1 = now();

    expect(t).toMatchObject({
      specialist_group_id: 'ag-b',
      prompt: 'look it up',
      requester_group_id: 'ag-main',
      requester_task_id: null,
      requester_session_id: 'sess-main',
      depth: 0,
      chain_delegation_count: 1,
      is_last_same_type_dispatch: 0,
      status: 'queued',
      restart_attempt_count: 0,
      closed_at: null,
    });
    expect(JSON.parse(t.ancestor_group_ids)).toEqual([]);
    expect(t.dispatched_at >= t0 && t.dispatched_at <= t1).toBe(true);
  });
});

// ── SpecialistTaskStarted ────────────────────────────────────────────────────

describe('SpecialistTaskStarted', () => {
  obligation('rule-success.SpecialistTaskStarted', async () => {
    await task({ id: 'task-q', specialist_group_id: 'ag-a', status: 'queued' });
    await task({ id: 'task-r', specialist_group_id: 'ag-b', status: 'awaiting_restart', restart_attempt_count: 1 });
    await session('sess-q', 'ag-a', 'task-q');
    await session('sess-r', 'ag-b', 'task-r');
    h.alive.add('sess-q').add('sess-r');

    await sweepSpecialistTasks();

    expect((await getTask('task-q'))!.status).toBe('running');
    const r = (await getTask('task-r'))!;
    expect(r.status).toBe('running');
    expect(r.restart_attempt_count).toBe(1);
  });

  obligation('rule-failure.SpecialistTaskStarted.1', async () => {
    // awaiting_sub_task, its container seen alive, its child well inside the await window.
    await parent({ status: 'awaiting_sub_task' });
    h.alive.add('sess-parent');

    await sweepSpecialistTasks();

    const p = await parentTask();
    expect(p.status).toBe('awaiting_sub_task');
    expect(p.pending_sub_task_id).toBe('task-pending');
  });
});

// ── SpecialistBootFailed ─────────────────────────────────────────────────────

describe('SpecialistBootFailed', () => {
  obligation('rule-success.SpecialistBootFailed', async () => {
    const cases = [
      ['task-q', 'queued', 0],
      ['task-r', 'running', 0],
      ['task-ar', 'awaiting_restart', 1],
    ] as const;
    for (const [id, status, restarts] of cases) {
      await task({ id, specialist_group_id: 'ag-a', status, restart_attempt_count: restarts });
      await session(`sess-${id}`, 'ag-a', id);
      h.bootCrashes.set(`sess-${id}`, 3);
    }
    // The bound decides whatever a liveness sample says.
    h.alive.add('sess-task-r');
    const t0 = now();

    await sweepSpecialistTasks();

    for (const [id, , restarts] of cases) {
      const t = (await getTask(id))!;
      expect(t.status).toBe('failed');
      expect(t.failure_kind).toBe('boot_failure');
      expect(t.failure_detail).toContain('failed to start');
      expect(t.closed_at! >= t0).toBe(true);
      expect(t.restart_attempt_count).toBe(restarts);
    }
    // The requester hears of each at once (SpecialistFailureRoutedToRequester).
    expect(told('sess-main').filter((m) => m.includes('boot_failure'))).toHaveLength(3);
  });

  covered(
    'rule-failure.SpecialistBootFailed.1',
    'src/modules/specialists/recovery.test.ts',
    'leaves an awaiting_sub_task task to the sub-task await path',
  );
});

// ── SpecialistDispatchesSubTask ──────────────────────────────────────────────

describe('SpecialistDispatchesSubTask', () => {
  obligation('rule-success.SpecialistDispatchesSubTask', async () => {
    const s = await parent();
    const made = await created(() => dispatchSub(s, 'ag-b', 'check the code'));

    expect(made).toHaveLength(1);
    const child = made[0];
    expect(child.status).toBe('queued');
    const p = await parentTask();
    expect(p.status).toBe('awaiting_sub_task');
    expect(p.pending_sub_task_id).toBe(child.id);
    const cs = (await taskSession(child.id))!;
    expect(cs).toMatchObject({
      agent_group_id: 'ag-b',
      messaging_group_id: 'mg-null',
      thread_id: child.id,
      status: 'active',
    });
    // Not the last same-type dispatch, so format_task_prompt is the prompt itself.
    expect(h.writes.filter((w) => w.sessionId === cs.id)).toEqual([
      expect.objectContaining({ text: 'check the code', trigger: true }),
    ]);
    expect(h.woken).toEqual([cs.id]);
    expect(told('sess-parent')).toEqual([]);
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.1', async () => {
    const s = await parent({ group: 'ag-plain' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made).toEqual([]);
    await noAcceptedSubTask(made, 'running');
    expect(told('sess-parent').join('\n')).toContain('dispatch_sub_task failed');
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.2', async () => {
    const s = await parent({ group: 'ag-mem' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made).toEqual([]);
    await noAcceptedSubTask(made, 'running');
    expect(told('sess-parent').join('\n')).toContain('memory providers cannot delegate');
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.3', async () => {
    const s = await parent();
    const made = await created(() => dispatchSub(s, 'ag-nope'));
    expect(made).toEqual([]);
    await noAcceptedSubTask(made, 'running');
    expect(told('sess-parent').join('\n')).toContain('not found');
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.4', async () => {
    const s = await parent();
    const made = await created(() => dispatchSub(s, 'ag-plain'));
    expect(made).toEqual([]);
    await noAcceptedSubTask(made, 'running');
    expect(told('sess-parent').join('\n')).toContain('is not a specialist');
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.5', async () => {
    // A memory-provider target is MemoryProviderDispatched's: the child does
    // not go a level deeper or spend a delegation.
    const s = await parent();
    const before = await parentTask();
    const [child] = await created(() => dispatchSub(s, 'ag-mem'));
    expect(child.depth).toBe(before.depth);
    expect(child.chain_delegation_count).toBe(before.chain_delegation_count);
    expect(child.ancestor_group_ids).toBe(before.ancestor_group_ids);
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.6', async () => {
    const s = await session('sess-orphan', 'ag-a', 'task-none');
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made).toEqual([]);
    expect(h.woken).toEqual([]);
    expect(told('sess-orphan').join('\n')).toContain('no running task');
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.7', async () => {
    const s = await parent({ status: 'awaiting_sub_task' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made).toEqual([]);
    await noAcceptedSubTask(made, 'awaiting_sub_task');
    expect(told('sess-parent').join('\n')).toContain('expected "running"');
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.8', async () => {
    const s = await parent({ depth: MAX_DEPTH - 1 });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    await noAcceptedSubTask(made, 'running');
    expect(made.map((t) => t.status)).toEqual(['failed']);
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.9', async () => {
    const s = await parent({ chain: MAX_CHAIN });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    await noAcceptedSubTask(made, 'running');
    expect(made.map((t) => t.status)).toEqual(['failed']);
  });

  obligation('rule-failure.SpecialistDispatchesSubTask.10', async () => {
    const s = await parent();
    await priorChildren('ag-b', MAX_SAME);
    const made = await created(() => dispatchSub(s, 'ag-b'));
    await noAcceptedSubTask(made, 'running');
    expect(made.map((t) => t.status)).toEqual(['failed']);
  });

  covered(
    'rule-failure.SpecialistDispatchesSubTask.11',
    'src/modules/specialists/dispatch-null-channel.test.ts',
    'creates no sub-task and leaves the parent running',
  );

  // The last allowed dispatch to a group: is_last_same_type_dispatch is set and
  // the trigger carries the last-turn notice (format_task_prompt), but the
  // task's prompt field is the prompt as given.
  obligation('rule-entity-creation.SpecialistDispatchesSubTask.1', async () => {
    const s = await parent();
    await priorChildren('ag-b', MAX_SAME - 1);
    const before = await parentTask();
    const t0 = now();
    const made = await created(() => dispatchSub(s, 'ag-b', 'final chunk'));
    const t1 = now();

    expect(made).toHaveLength(1);
    const child = made[0];
    const cs = (await taskSession(child.id))!;
    expect(h.writes.filter((w) => w.sessionId === cs.id).map((w) => w.text)).toEqual([
      `final chunk\n\n${SPECIALISTS_CONFIG.defaultLastTurnSubNotice}`,
    ]);
    expect(child.dispatched_at >= t0 && child.dispatched_at <= t1).toBe(true);
    expect(JSON.parse(child.ancestor_group_ids)).toEqual([...JSON.parse(before.ancestor_group_ids), 'ag-a']);
    expect(child).toMatchObject({
      specialist_group_id: 'ag-b',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      depth: before.depth + 1,
      chain_delegation_count: before.chain_delegation_count + 1,
      is_last_same_type_dispatch: 1,
      status: 'queued',
      restart_attempt_count: 0,
      closed_at: null,
    });
    // The notice is part of the stored prompt (with_last_turn_notice), so a
    // restarted child is sent it again with its prompt.
    expect(child.prompt).toBe(`final chunk\n\n${SPECIALISTS_CONFIG.defaultLastTurnSubNotice}`);
  });
});

// ── SubTaskRejectedDepth ─────────────────────────────────────────────────────

const depthLimited = () => parent({ depth: MAX_DEPTH - 1 });
const failuresOf = (made: SpecialistTask[], kind: string) => made.filter((t) => t.failure_kind === kind);

describe('SubTaskRejectedDepth', () => {
  obligation('rule-success.SubTaskRejectedDepth', async () => {
    const s = await depthLimited();
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made.map((t) => [t.status, t.failure_kind])).toEqual([['failed', 'depth_exceeded']]);
    expect(told('sess-parent')).toEqual(['sub-task rejected: depth limit reached']);
    expect((await parentTask()).status).toBe('running');
    expect(await taskSession(made[0].id)).toBeUndefined();
    expect(h.woken).toEqual([]);
  });

  obligation('rule-failure.SubTaskRejectedDepth.1', async () => {
    const s = await parent({ group: 'ag-plain', depth: MAX_DEPTH - 1 });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'depth_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain('sub-task rejected: depth limit reached');
  });

  obligation('rule-failure.SubTaskRejectedDepth.2', async () => {
    const s = await parent({ group: 'ag-mem', depth: MAX_DEPTH - 1 });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'depth_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain('sub-task rejected: depth limit reached');
  });

  obligation('rule-failure.SubTaskRejectedDepth.3', async () => {
    const s = await depthLimited();
    const made = await created(() => dispatchSub(s, 'ag-nope'));
    expect(failuresOf(made, 'depth_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain('sub-task rejected: depth limit reached');
  });

  obligation('rule-failure.SubTaskRejectedDepth.4', async () => {
    const s = await depthLimited();
    const made = await created(() => dispatchSub(s, 'ag-plain'));
    expect(failuresOf(made, 'depth_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain('sub-task rejected: depth limit reached');
  });

  obligation('rule-failure.SubTaskRejectedDepth.5', async () => {
    // A memory-provider lookup bypasses the depth limit.
    const s = await depthLimited();
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    expect(failuresOf(made, 'depth_exceeded')).toEqual([]);
    expect(made.map((t) => t.status)).toEqual(['queued']);
    expect((await parentTask()).status).toBe('awaiting_sub_task');
  });

  obligation('rule-failure.SubTaskRejectedDepth.6', async () => {
    const s = await session('sess-orphan', 'ag-a', 'task-none');
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made).toEqual([]);
    expect(told('sess-orphan')).not.toContain('sub-task rejected: depth limit reached');
  });

  obligation('rule-failure.SubTaskRejectedDepth.7', async () => {
    const s = await parent({ status: 'awaiting_sub_task', depth: MAX_DEPTH - 1 });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'depth_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain('sub-task rejected: depth limit reached');
  });

  obligation('rule-failure.SubTaskRejectedDepth.8', async () => {
    const s = await parent({ depth: MAX_DEPTH - 2 });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'depth_exceeded')).toEqual([]);
    expect(made.map((t) => [t.status, t.depth])).toEqual([['queued', MAX_DEPTH - 1]]);
  });

  obligation('rule-entity-creation.SubTaskRejectedDepth.1', async () => {
    const s = await depthLimited();
    const before = await parentTask();
    const t0 = now();
    const [t] = await created(() => dispatchSub(s, 'ag-b', 'too deep'));
    const t1 = now();
    expect(t).toMatchObject({
      specialist_group_id: 'ag-b',
      prompt: 'too deep',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      depth: before.depth + 1,
      chain_delegation_count: before.chain_delegation_count + 1,
      is_last_same_type_dispatch: 0,
      status: 'failed',
      failure_kind: 'depth_exceeded',
      failure_detail: 'specialist chain depth limit reached',
    });
    expect(JSON.parse(t.ancestor_group_ids)).toEqual([...JSON.parse(before.ancestor_group_ids), 'ag-a']);
    expect(t.dispatched_at >= t0 && t.dispatched_at <= t1).toBe(true);
    expect(t.closed_at).toBe(t.dispatched_at);
  });
});

// ── SubTaskRejectedCount ─────────────────────────────────────────────────────

const countLimited = (o: { group?: string; status?: SpecialistTask['status'] } = {}) =>
  parent({ ...o, depth: 1, chain: MAX_CHAIN });
const COUNT_TEXT = 'sub-task rejected: chain delegation limit reached';

describe('SubTaskRejectedCount', () => {
  obligation('rule-success.SubTaskRejectedCount', async () => {
    const s = await countLimited();
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made.map((t) => [t.status, t.failure_kind])).toEqual([['failed', 'count_exceeded']]);
    expect(told('sess-parent')).toEqual([COUNT_TEXT]);
    expect((await parentTask()).status).toBe('running');
    expect(h.woken).toEqual([]);
  });

  obligation('rule-failure.SubTaskRejectedCount.1', async () => {
    const s = await countLimited({ group: 'ag-plain' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'count_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(COUNT_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedCount.2', async () => {
    const s = await countLimited({ group: 'ag-mem' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'count_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(COUNT_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedCount.3', async () => {
    const s = await countLimited();
    const made = await created(() => dispatchSub(s, 'ag-nope'));
    expect(failuresOf(made, 'count_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(COUNT_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedCount.4', async () => {
    const s = await countLimited();
    const made = await created(() => dispatchSub(s, 'ag-plain'));
    expect(failuresOf(made, 'count_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(COUNT_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedCount.5', async () => {
    // A memory-provider lookup is invisible to the chain counters.
    const s = await countLimited();
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    expect(failuresOf(made, 'count_exceeded')).toEqual([]);
    expect(made.map((t) => [t.status, t.chain_delegation_count])).toEqual([['queued', MAX_CHAIN]]);
  });

  obligation('rule-failure.SubTaskRejectedCount.6', async () => {
    const s = await session('sess-orphan', 'ag-a', 'task-none');
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made).toEqual([]);
    expect(told('sess-orphan')).not.toContain(COUNT_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedCount.7', async () => {
    const s = await countLimited({ status: 'awaiting_sub_task' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'count_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(COUNT_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedCount.8', async () => {
    // At the depth limit too: the depth rule takes it, not the count rule.
    const s = await parent({ depth: MAX_DEPTH - 1, chain: MAX_CHAIN });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made.map((t) => t.failure_kind)).toEqual(['depth_exceeded']);
    expect(told('sess-parent')).not.toContain(COUNT_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedCount.9', async () => {
    const s = await parent({ depth: 1, chain: MAX_CHAIN - 1 });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'count_exceeded')).toEqual([]);
    expect(made.map((t) => [t.status, t.chain_delegation_count])).toEqual([['queued', MAX_CHAIN]]);
  });

  obligation('rule-entity-creation.SubTaskRejectedCount.1', async () => {
    const s = await countLimited();
    const before = await parentTask();
    const t0 = now();
    const [t] = await created(() => dispatchSub(s, 'ag-b', 'one more'));
    const t1 = now();
    expect(t).toMatchObject({
      specialist_group_id: 'ag-b',
      prompt: 'one more',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      depth: before.depth + 1,
      chain_delegation_count: before.chain_delegation_count + 1,
      is_last_same_type_dispatch: 0,
      status: 'failed',
      failure_kind: 'count_exceeded',
      failure_detail: 'specialist chain delegation count limit reached',
    });
    expect(JSON.parse(t.ancestor_group_ids)).toEqual([...JSON.parse(before.ancestor_group_ids), 'ag-a']);
    expect(t.dispatched_at >= t0 && t.dispatched_at <= t1).toBe(true);
    expect(t.closed_at).toBe(t.dispatched_at);
  });
});

// ── SubTaskRejectedSameTypeLimit ─────────────────────────────────────────────

const SAME_TEXT = 'sub-task rejected: same-type dispatch limit reached';
async function sameTypeLimited(o: { group?: string; status?: SpecialistTask['status'] } = {}): Promise<Session> {
  const s = await parent(o);
  await priorChildren('ag-b', MAX_SAME);
  return s;
}

describe('SubTaskRejectedSameTypeLimit', () => {
  obligation('rule-success.SubTaskRejectedSameTypeLimit', async () => {
    const s = await sameTypeLimited();
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made.map((t) => [t.status, t.failure_kind])).toEqual([['failed', 'same_type_limit_exceeded']]);
    expect(told('sess-parent')).toEqual([SAME_TEXT]);
    expect((await parentTask()).status).toBe('running');
    expect(h.woken).toEqual([]);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.1', async () => {
    const s = await sameTypeLimited({ group: 'ag-plain' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'same_type_limit_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.2', async () => {
    const s = await sameTypeLimited({ group: 'ag-mem' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'same_type_limit_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.3', async () => {
    const s = await sameTypeLimited();
    const made = await created(() => dispatchSub(s, 'ag-nope'));
    expect(failuresOf(made, 'same_type_limit_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.4', async () => {
    const s = await parent();
    await priorChildren('ag-plain', MAX_SAME);
    const made = await created(() => dispatchSub(s, 'ag-plain'));
    expect(failuresOf(made, 'same_type_limit_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.5', async () => {
    // Memory-provider lookups bypass the same-type limit.
    const s = await parent();
    await priorChildren('ag-mem', MAX_SAME);
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    expect(failuresOf(made, 'same_type_limit_exceeded')).toEqual([]);
    expect(made.map((t) => t.status)).toEqual(['queued']);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.6', async () => {
    const s = await session('sess-orphan', 'ag-a', 'task-none');
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made).toEqual([]);
    expect(told('sess-orphan')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.7', async () => {
    const s = await sameTypeLimited({ status: 'awaiting_sub_task' });
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'same_type_limit_exceeded')).toEqual([]);
    expect(told('sess-parent')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.8', async () => {
    const s = await parent({ depth: MAX_DEPTH - 1 });
    await priorChildren('ag-b', MAX_SAME);
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made.map((t) => t.failure_kind)).toEqual(['depth_exceeded']);
    expect(told('sess-parent')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.9', async () => {
    const s = await parent({ depth: 1, chain: MAX_CHAIN });
    await priorChildren('ag-b', MAX_SAME);
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(made.map((t) => t.failure_kind)).toEqual(['count_exceeded']);
    expect(told('sess-parent')).not.toContain(SAME_TEXT);
  });

  obligation('rule-failure.SubTaskRejectedSameTypeLimit.10', async () => {
    const s = await parent();
    await priorChildren('ag-b', MAX_SAME - 1);
    const made = await created(() => dispatchSub(s, 'ag-b'));
    expect(failuresOf(made, 'same_type_limit_exceeded')).toEqual([]);
    expect(made.map((t) => [t.status, t.is_last_same_type_dispatch])).toEqual([['queued', 1]]);
  });

  obligation('rule-entity-creation.SubTaskRejectedSameTypeLimit.1', async () => {
    const s = await sameTypeLimited();
    const before = await parentTask();
    const t0 = now();
    const [t] = await created(() => dispatchSub(s, 'ag-b', 'again'));
    const t1 = now();
    expect(t).toMatchObject({
      specialist_group_id: 'ag-b',
      prompt: 'again',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      depth: before.depth + 1,
      chain_delegation_count: before.chain_delegation_count + 1,
      is_last_same_type_dispatch: 0,
      status: 'failed',
      failure_kind: 'same_type_limit_exceeded',
      failure_detail: 'specialist same-type dispatch limit reached',
    });
    expect(JSON.parse(t.ancestor_group_ids)).toEqual([...JSON.parse(before.ancestor_group_ids), 'ag-a']);
    expect(t.dispatched_at >= t0 && t.dispatched_at <= t1).toBe(true);
    expect(t.closed_at).toBe(t.dispatched_at);
  });
});

// ── MemoryProviderDispatched ─────────────────────────────────────────────────

/** Nothing of MemoryProviderDispatched happened: no memory-provider child, parent as it was. */
async function noMemoryLookup(made: SpecialistTask[], parentStatus: SpecialistTask['status']): Promise<void> {
  expect(made.filter((t) => t.specialist_group_id === 'ag-mem' && t.status === 'queued')).toEqual([]);
  await noAcceptedSubTask(made, parentStatus);
}

describe('MemoryProviderDispatched', () => {
  obligation('rule-success.MemoryProviderDispatched', async () => {
    const s = await parent();
    const made = await created(() => dispatchSub(s, 'ag-mem', 'what do we know about X'));

    expect(made).toHaveLength(1);
    const child = made[0];
    const p = await parentTask();
    expect(p.status).toBe('awaiting_sub_task');
    expect(p.pending_sub_task_id).toBe(child.id);
    const cs = (await taskSession(child.id))!;
    expect(cs).toMatchObject({
      agent_group_id: 'ag-mem',
      messaging_group_id: 'mg-null',
      thread_id: child.id,
      status: 'active',
    });
    expect(h.writes.filter((w) => w.sessionId === cs.id)).toEqual([
      expect.objectContaining({ text: 'what do we know about X', trigger: true }),
    ]);
    expect(h.woken).toEqual([cs.id]);
  });

  obligation('rule-failure.MemoryProviderDispatched.1', async () => {
    const s = await parent({ group: 'ag-plain' });
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    await noMemoryLookup(made, 'running');
    expect(told('sess-parent').join('\n')).toContain('not a specialist');
  });

  obligation('rule-failure.MemoryProviderDispatched.2', async () => {
    const s = await parent({ group: 'ag-mem' });
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    await noMemoryLookup(made, 'running');
    expect(told('sess-parent').join('\n')).toContain('memory providers cannot delegate');
  });

  obligation('rule-failure.MemoryProviderDispatched.3', async () => {
    const s = await parent();
    const made = await created(() => dispatchSub(s, 'ag-nope'));
    await noMemoryLookup(made, 'running');
    expect(made).toEqual([]);
  });

  obligation('rule-failure.MemoryProviderDispatched.4', async () => {
    const s = await parent();
    const made = await created(() => dispatchSub(s, 'ag-plain'));
    await noMemoryLookup(made, 'running');
    expect(made).toEqual([]);
  });

  obligation('rule-failure.MemoryProviderDispatched.5', async () => {
    // A non-memory target is an ordinary delegation: it goes a level deeper.
    const s = await parent();
    const before = await parentTask();
    const [child] = await created(() => dispatchSub(s, 'ag-b'));
    expect(child.depth).toBe(before.depth + 1);
    expect(child.chain_delegation_count).toBe(before.chain_delegation_count + 1);
  });

  obligation('rule-failure.MemoryProviderDispatched.6', async () => {
    const s = await session('sess-orphan', 'ag-a', 'task-none');
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    expect(made).toEqual([]);
    expect(h.woken).toEqual([]);
  });

  obligation('rule-failure.MemoryProviderDispatched.7', async () => {
    const s = await parent({ status: 'awaiting_sub_task' });
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    await noMemoryLookup(made, 'awaiting_sub_task');
    expect(made).toEqual([]);
  });

  obligation('rule-failure.MemoryProviderDispatched.8', async () => {
    h.nullChannelPresent = false;
    const s = await parent();
    const sessionsBefore = await sessionCount();
    const made = await created(() => dispatchSub(s, 'ag-mem'));
    expect(made).toEqual([]);
    await noMemoryLookup(made, 'running');
    expect(await sessionCount()).toBe(sessionsBefore);
    expect(told('sess-parent').join('\n')).toContain('dispatch_sub_task failed');
  });

  obligation('rule-entity-creation.MemoryProviderDispatched.1', async () => {
    const s = await parent({ depth: 3, chain: 7 });
    const before = await parentTask();
    const t0 = now();
    const [child] = await created(() => dispatchSub(s, 'ag-mem', 'recall'));
    const t1 = now();
    expect(child).toMatchObject({
      specialist_group_id: 'ag-mem',
      prompt: 'recall',
      requester_group_id: null,
      requester_task_id: 'task-parent',
      requester_session_id: 'sess-parent',
      depth: before.depth,
      chain_delegation_count: before.chain_delegation_count,
      ancestor_group_ids: before.ancestor_group_ids,
      is_last_same_type_dispatch: 0,
      status: 'queued',
      restart_attempt_count: 0,
      closed_at: null,
    });
    expect(child.dispatched_at >= t0 && child.dispatched_at <= t1).toBe(true);
  });
});

// ── SpecialistTask.status transitions ────────────────────────────────────────

describe('SpecialistTask.status', () => {
  covered(
    'transition-edge.SpecialistTask.queued.running',
    'src/modules/specialists/recovery.test.ts',
    'advances a queued task to running when its container starts',
  );

  covered(
    'transition-edge.SpecialistTask.queued.failed',
    'src/modules/specialists/recovery.test.ts',
    'fails a queued task once its container has boot-crashed repeatedly',
  );

  covered(
    'transition-edge.SpecialistTask.running.awaiting_sub_task',
    'src/modules/specialists/task-by-session.test.ts',
    "suspends the dispatching session's own task",
  );

  covered(
    'transition-edge.SpecialistTask.running.awaiting_restart',
    'src/modules/specialists/recovery.test.ts',
    'still crash-detects a running task whose container stopped',
  );

  covered(
    'transition-edge.SpecialistTask.running.completed',
    'src/modules/specialists/task-by-session.test.ts',
    "completes the delivering session's own task",
  );

  covered(
    'transition-edge.SpecialistTask.running.failed',
    'src/modules/specialists/recovery.test.ts',
    'fails a running task whose container is crash-looping',
  );

  covered(
    'transition-edge.SpecialistTask.awaiting_sub_task.awaiting_restart',
    'src/modules/specialists/recovery.test.ts',
    'transitions awaiting_sub_task parent to awaiting_restart when child is overdue and retries remain',
  );

  obligation('transition-edge.SpecialistTask.awaiting_sub_task.running', async () => {
    // SpecialistResultRoutedToParent, end to end: the parent delegates, the
    // child delivers, and the parent resumes.
    const s = await parent();
    const [child] = await created(() => dispatchSub(s, 'ag-b', 'help'));
    expect((await parentTask()).status).toBe('awaiting_sub_task');
    const childSession = (await taskSession(child.id))!;

    await handleDeliverSpecialistResult({ result_text: 'here is the help' }, childSession);

    expect((await getTask(child.id))!.status).toBe('completed');
    const p = await parentTask();
    expect(p.status).toBe('running');
    expect(p.pending_sub_task_id).toBeNull();
    expect(h.writes.filter((w) => w.sessionId === 'sess-parent')).toEqual([
      expect.objectContaining({ text: 'here is the help', trigger: true }),
    ]);
    expect(h.woken).toContain('sess-parent');
  });

  covered(
    'transition-edge.SpecialistTask.awaiting_sub_task.failed',
    'src/modules/specialists/recovery.test.ts',
    'fails the parent with kind=timeout when retries are exhausted',
  );

  obligation('transition-edge.SpecialistTask.awaiting_restart.running', async () => {
    await task({ id: 'task-ar', specialist_group_id: 'ag-a', status: 'awaiting_restart', restart_attempt_count: 1 });
    await session('sess-ar', 'ag-a', 'task-ar');
    h.alive.add('sess-ar');

    await sweepSpecialistTasks();

    const t = (await getTask('task-ar'))!;
    expect(t.status).toBe('running');
    expect(t.restart_attempt_count).toBe(1);
  });

  obligation('transition-edge.SpecialistTask.awaiting_restart.failed', async () => {
    await task({ id: 'task-ar', specialist_group_id: 'ag-a', status: 'awaiting_restart', restart_attempt_count: 1 });
    await session('sess-ar', 'ag-a', 'task-ar');
    h.bootCrashes.set('sess-ar', 3);

    await sweepSpecialistTasks();

    const t = (await getTask('task-ar'))!;
    expect(t.status).toBe('failed');
    expect(t.failure_kind).toBe('boot_failure');
    expect(t.restart_attempt_count).toBe(1);
  });

  obligation('transition-rejected.SpecialistTask.status', async () => {
    // queued -/-> awaiting_restart: a queued task with no container is waiting, not crashed.
    await task({ id: 'task-q', specialist_group_id: 'ag-b', status: 'queued' });
    await session('sess-q', 'ag-b', 'task-q');
    // awaiting_sub_task -/-> running (without its child's result), -/-> completed, -/-> awaiting_sub_task again.
    const s = await parent({ status: 'awaiting_sub_task' });
    h.alive.add('sess-parent');

    for (let i = 0; i < 3; i++) await sweepSpecialistTasks();
    const q = (await getTask('task-q'))!;
    expect(q.status).toBe('queued');
    expect(q.restart_attempt_count).toBe(0);
    expect((await parentTask()).status).toBe('awaiting_sub_task');

    await handleDeliverSpecialistResult({ result_text: 'premature' }, s);
    const made = await created(() => dispatchSub(s, 'ag-a'));

    expect(made).toEqual([]);
    const p = await parentTask();
    expect(p.status).toBe('awaiting_sub_task');
    expect(p.result).toBeNull();
    expect(p.pending_sub_task_id).toBe('task-pending');
  });

  obligation('transition-terminal.SpecialistTask.status', async () => {
    // A completed and a failed task, each with a session still marked active
    // and a container seen alive and crash-looping: nothing moves them.
    await task({ id: 'task-done', specialist_group_id: 'ag-a', status: 'completed', result: 'r', closed_at: now() });
    await task({
      id: 'task-dead',
      specialist_group_id: 'ag-a',
      status: 'failed',
      failure_kind: 'timeout',
      failure_detail: 'x',
      closed_at: now(),
    });
    const done = await session('sess-done', 'ag-a', 'task-done');
    const dead = await session('sess-dead', 'ag-a', 'task-dead');
    // A child of the failed task delivers its result.
    await task({
      id: 'task-orphan-child',
      specialist_group_id: 'ag-b',
      requester_group_id: null,
      requester_task_id: 'task-dead',
      requester_session_id: 'sess-dead',
      status: 'running',
    });
    const childSession = await session('sess-orphan-child', 'ag-b', 'task-orphan-child');
    for (const id of ['sess-done', 'sess-dead']) {
      h.alive.add(id);
      h.bootCrashes.set(id, 5);
    }
    const snapshot = async () => [await getTask('task-done'), await getTask('task-dead')];
    const before = await snapshot();

    await sweepSpecialistTasks();
    await handleDeliverSpecialistResult({ result_text: 'again' }, done);
    await handleDeliverSpecialistResult({ result_text: 'again' }, dead);
    const made = await created(async () => {
      await dispatchSub(done, 'ag-b');
      await dispatchSub(dead, 'ag-b');
    });
    await handleDeliverSpecialistResult({ result_text: 'late child result' }, childSession);

    expect(made).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await getTask('task-orphan-child'))!.status).toBe('completed');
    expect(told('sess-dead')).not.toContain('late child result');
  });
});
