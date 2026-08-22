/**
 * Concurrency cap and FIFO queue.
 *
 * Drives the admission gate directly rather than through `wakeContainer`: the
 * gate IS the feature, and testing it through a spawn path would only prove
 * the mock works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { hooks, mockWake, mockDbGet } = vi.hoisted(() => ({
  hooks: [] as Array<(e: { sessionId: string }) => void>,
  mockWake: vi.fn(async (_session: { id: string; agent_group_id: string }) => true),
  mockDbGet: vi.fn(async (_sql: string, _params: unknown[]) => undefined as unknown),
}));

vi.mock('../../container-runner.js', () => ({
  setWakeGate: vi.fn(),
  registerSessionExitHook: (hook: (e: { sessionId: string }) => void) => hooks.push(hook),
  wakeContainer: mockWake,
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
  getQueueStatus,
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
