/**
 * Concurrency cap and FIFO queue.
 *
 * Drives the admission gate directly rather than through `wakeContainer`: the
 * gate IS the feature, and testing it through a spawn path would only prove
 * the mock works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { hooks, mockWake, mockDbGet, adopted, closed } = vi.hoisted(() => ({
  hooks: [] as Array<(e: { sessionId: string }) => void>,
  mockWake: vi.fn(async (_session: { id: string; agent_group_id: string }) => true),
  mockDbGet: vi.fn(async (_sql: string, _params: unknown[]) => undefined as unknown),
  // Sessions whose containers survived a host restart and were adopted.
  adopted: [] as Array<{ id: string; agent_group_id: string }>,
  // Sessions closed while they waited in the queue.
  closed: new Set<string>(),
}));

vi.mock('../../container-runner.js', () => ({
  setWakeGate: vi.fn(),
  registerSessionExitHook: (hook: (e: { sessionId: string }) => void) => hooks.push(hook),
  wakeContainer: mockWake,
  isContainerRunning: (id: string) => adopted.some((s) => s.id === id),
}));
vi.mock('../../db/sessions.js', () => ({
  getRunningSessions: async () => adopted,
  getSession: async (id: string) => ({ id, agent_group_id: 'g-worker', status: closed.has(id) ? 'closed' : 'active' }),
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({ get: mockDbGet }) }));
vi.mock('../../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./migration.js', () => ({}));

import {
  MAX_CONCURRENT_CONTAINERS,
  admitForTesting,
  countAdoptedContainers,
  getQueueStatus,
  releaseForTesting,
  resetConcurrencyStateForTesting,
} from './index.js';
import type { Session } from '../../types.js';

function session(id: string, group = 'g-worker'): Session {
  return { id, agent_group_id: group } as Session;
}

/** Fire the registered session-exit hook, as container-runner's finish() does. */
function exit(sessionId: string): void {
  for (const hook of hooks) hook({ sessionId });
}

beforeEach(() => {
  resetConcurrencyStateForTesting();
  adopted.length = 0;
  closed.clear();
  mockWake.mockClear();
  mockWake.mockImplementation(async () => true);
  mockDbGet.mockClear();
  mockDbGet.mockImplementation(async () => undefined);
});

afterEach(() => {
  resetConcurrencyStateForTesting();
});

describe('the cap', () => {
  it('defaults to 5', () => {
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it('admits up to the cap and queues the rest', async () => {
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) {
      expect(await admitForTesting(session(`s${i}`))).toBe(true);
    }
    expect(await admitForTesting(session('one-too-many'))).toBe(false);
    expect(getQueueStatus()).toEqual({
      activeNonMain: MAX_CONCURRENT_CONTAINERS,
      max: MAX_CONCURRENT_CONTAINERS,
      waiting: 1,
    });
  });

  it('exempts the main group even when the cap is full', async () => {
    mockDbGet.mockImplementation(async (_sql, params) =>
      (params as string[])[0] === 'g-main' ? { is_main: 1 } : { is_main: 0 },
    );
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));

    // The operator's own line must not wait behind its own background agents.
    expect(await admitForTesting(session('operator', 'g-main'))).toBe(true);
    expect(getQueueStatus().waiting).toBe(0);
  });

  it('treats a session already holding a slot as admitted, not as a new claim', async () => {
    await admitForTesting(session('s1'));
    await admitForTesting(session('s1'));
    expect(getQueueStatus().activeNonMain).toBe(1);
  });

  it('does not enqueue the same session twice', async () => {
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));
    await admitForTesting(session('waiter'));
    await admitForTesting(session('waiter'));
    expect(getQueueStatus().waiting).toBe(1);
  });

  it('never counts a main-group session against the cap', async () => {
    mockDbGet.mockImplementation(async () => ({ is_main: 1 }));
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS + 3; i++) {
      expect(await admitForTesting(session(`s${i}`, 'g-main'))).toBe(true);
    }
    expect(getQueueStatus().activeNonMain).toBe(0);
  });
});

describe('draining on exit', () => {
  it('starts the longest-waiting session when a slot frees', async () => {
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));
    await admitForTesting(session('first-waiter'));
    await admitForTesting(session('second-waiter'));

    exit('s0');
    await vi.waitFor(() => expect(mockWake).toHaveBeenCalled());

    // FIFO: whoever queued first goes first.
    expect(mockWake.mock.calls[0][0]).toMatchObject({ id: 'first-waiter' });
    expect(getQueueStatus().waiting).toBe(1);
  });

  it('ignores an exit from a session that held no slot', async () => {
    await admitForTesting(session('s1'));
    exit('never-admitted');
    expect(getQueueStatus().activeNonMain).toBe(1);
    expect(mockWake).not.toHaveBeenCalled();
  });

  it('releases the slot when a dequeued wake fails to spawn', async () => {
    // Otherwise the cap leaks one slot per failure until nothing can start.
    mockWake.mockImplementation(async () => false);
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));
    await admitForTesting(session('doomed'));

    exit('s0');
    await vi.waitFor(() => expect(getQueueStatus().activeNonMain).toBe(MAX_CONCURRENT_CONTAINERS - 1));
    expect(getQueueStatus().waiting).toBe(0);
  });

  it('releases the slot when a dequeued wake throws', async () => {
    mockWake.mockImplementation(async () => {
      throw new Error('runtime unreachable');
    });
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));
    await admitForTesting(session('doomed'));

    exit('s0');
    await vi.waitFor(() => expect(getQueueStatus().activeNonMain).toBe(MAX_CONCURRENT_CONTAINERS - 1));
  });

  it('takes the slot back from an admitted wake that never started, and starts the next waiter', async () => {
    // container-runner calls the gate's release for a wake that registered no
    // runtime — that wake will never produce an exit event.
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));
    await admitForTesting(session('waiter'));

    releaseForTesting(session('s0'));
    await vi.waitFor(() => expect(mockWake).toHaveBeenCalledOnce());
    expect(mockWake.mock.calls[0][0]).toMatchObject({ id: 'waiter' });
    expect(getQueueStatus()).toMatchObject({ activeNonMain: MAX_CONCURRENT_CONTAINERS, waiting: 0 });

    // A second hand-back for the same wake (the exit hook, say) changes nothing.
    releaseForTesting(session('s0'));
    exit('s0');
    expect(getQueueStatus().activeNonMain).toBe(MAX_CONCURRENT_CONTAINERS);
  });

  it('fills every freed slot, not just one', async () => {
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));
    await admitForTesting(session('w1'));
    await admitForTesting(session('w2'));

    exit('s0');
    exit('s1');
    await vi.waitFor(() => expect(getQueueStatus().waiting).toBe(0));
    expect(mockWake).toHaveBeenCalledTimes(2);
  });
});

describe('is_main lookup', () => {
  it('treats a failed lookup as non-main, so the cap throttles rather than overcommits', async () => {
    mockDbGet.mockImplementation(async () => {
      throw new Error('no such column: is_main');
    });
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`s${i}`));
    expect(await admitForTesting(session('extra'))).toBe(false);
  });

  it('reads each group once and caches the answer', async () => {
    mockDbGet.mockImplementation(async () => ({ is_main: 0 }));
    await admitForTesting(session('s1', 'g-worker'));
    await admitForTesting(session('s2', 'g-worker'));
    await admitForTesting(session('s3', 'g-worker'));
    expect(mockDbGet).toHaveBeenCalledTimes(1);
  });
});

// S20: containers that survive a host restart are adopted without passing the
// gate, so the slot set started empty and a full set of new containers was
// admitted on top of them.
describe('containers adopted at host restart', () => {
  it('take their slots, so new wakes queue rather than overcommit', async () => {
    // The main group is exempt from the cap, so its adopted container is not counted.
    mockDbGet.mockImplementation(async (_sql: string, params: unknown) =>
      (Array.isArray(params) ? params[0] : params) === 'g-main' ? { is_main: 1 } : { is_main: 0 },
    );
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) adopted.push(session(`adopted-${i}`));
    adopted.push(session('adopted-main', 'g-main'));

    expect(await countAdoptedContainers()).toBe(MAX_CONCURRENT_CONTAINERS);
    expect(await admitForTesting(session('new-wake'))).toBe(false);
    expect(getQueueStatus().waiting).toBe(1);

    // An adopted container's exit hands its slot to the waiter.
    exit('adopted-0');
    await vi.waitFor(() => expect(mockWake).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-wake' })));
  });
});

// S21: the queue held each Session as it was when queued, and nothing re-read
// its status before spawning, so a session closed while it waited (a finished
// specialist task, a closed thread) still got a container and held the slot.
describe('a session closed while it waited', () => {
  it('is not woken; its slot goes to the next waiter', async () => {
    for (let i = 0; i < MAX_CONCURRENT_CONTAINERS; i++) await admitForTesting(session(`busy-${i}`));
    await admitForTesting(session('closed-meanwhile'));
    await admitForTesting(session('still-wanted'));
    closed.add('closed-meanwhile');

    exit('busy-0');

    await vi.waitFor(() => expect(mockWake).toHaveBeenCalledWith(expect.objectContaining({ id: 'still-wanted' })));
    expect(mockWake).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'closed-meanwhile' }));
    expect(getQueueStatus()).toMatchObject({ activeNonMain: MAX_CONCURRENT_CONTAINERS, waiting: 0 });
  });
});
