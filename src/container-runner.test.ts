import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

// ── Concurrency cap and FIFO queue (sessions.allium) ────────────────────────
//
// Spec obligations covered:
//   config-default.max_concurrent_containers (= 5)
//   rule SessionProcessingStarted  — wake when under cap or main group
//   rule SessionQueued             — queue when cap full, non-main
//   rule ContainerSlotFreed        — FIFO drain on container exit
//   rule StuckSessionRecovered     — stuck re-wakes when queue is empty / main
//   rule StuckSessionQueued        — stuck goes to back of queue when waiters exist
//   invariant ActiveContainerLimit — non-main active count <= cap at all times
//   invariant AtMostOneWaitingEntryPerSession — no duplicate queue entries

vi.mock('./db/agent-groups.js', () => ({
  isMainGroup: vi.fn().mockReturnValue(false),
  getAgentGroup: vi.fn().mockReturnValue(undefined),
  getAgentGroupByFolder: vi.fn().mockReturnValue(undefined),
  getAllAgentGroups: vi.fn().mockReturnValue([]),
  createAgentGroup: vi.fn(),
  updateAgentGroup: vi.fn(),
}));

import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import {
  _resetQueueStateForTesting,
  _setWakeImplForTesting,
  _simulateContainerExitForTesting,
  getQueueStatus,
  wakeOrQueue,
} from './container-runner.js';
import { isMainGroup } from './db/agent-groups.js';
import type { Session } from './types.js';

const isMainGroupMock = isMainGroup as ReturnType<typeof vi.fn>;

function makeSession(id: string, agentGroupId = 'ag-non-main'): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    processing_state: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

const fakeWake = vi.fn().mockResolvedValue(true);
const fakeWakeFail = vi.fn().mockResolvedValue(false);

beforeEach(() => {
  isMainGroupMock.mockReturnValue(false);
  fakeWake.mockClear();
  fakeWakeFail.mockClear();
  _resetQueueStateForTesting();
  _setWakeImplForTesting(fakeWake);
});

// ── config_default.max_concurrent_containers ─────────────────────────────────

describe('config_default.max_concurrent_containers', () => {
  it('defaults to 5 when env var is absent', () => {
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });
});

// ── getQueueStatus ────────────────────────────────────────────────────────────

describe('getQueueStatus', () => {
  it('reports zero active and zero waiting initially', () => {
    const s = getQueueStatus();
    expect(s.activeNonMain).toBe(0);
    expect(s.waiting).toBe(0);
    expect(s.max).toBe(MAX_CONCURRENT_CONTAINERS);
  });

  it('increments activeNonMain when a non-main session wakes', async () => {
    await wakeOrQueue(makeSession('s1'));
    expect(getQueueStatus().activeNonMain).toBe(1);
    expect(getQueueStatus().waiting).toBe(0);
  });

  it('decrements activeNonMain on simulated container exit', async () => {
    await wakeOrQueue(makeSession('s1'));
    _simulateContainerExitForTesting('s1');
    expect(getQueueStatus().activeNonMain).toBe(0);
  });
});

// ── rule SessionProcessingStarted ─────────────────────────────────────────────

describe('SessionProcessingStarted — non-main under cap', () => {
  it('wakes immediately when active non-main count is below the cap', async () => {
    const ok = await wakeOrQueue(makeSession('s1'));
    expect(ok).toBe(true);
    expect(fakeWake).toHaveBeenCalledOnce();
    expect(getQueueStatus()).toMatchObject({ activeNonMain: 1, waiting: 0 });
  });

  it('wakes up to cap sessions simultaneously without queuing any', async () => {
    const results = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => wakeOrQueue(makeSession(`s${i}`))),
    );
    expect(results.every((r) => r === true)).toBe(true);
    expect(getQueueStatus()).toMatchObject({
      activeNonMain: MAX_CONCURRENT_CONTAINERS,
      waiting: 0,
    });
  });
});

describe('SessionProcessingStarted — main group bypasses cap (is_main)', () => {
  it('wakes main-group session even when the cap is full', async () => {
    // Fill cap with non-main sessions.
    await Promise.all(Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => wakeOrQueue(makeSession(`s${i}`))));
    expect(getQueueStatus().activeNonMain).toBe(MAX_CONCURRENT_CONTAINERS);

    // Main-group session — should bypass the cap.
    isMainGroupMock.mockReturnValue(true);
    const ok = await wakeOrQueue(makeSession('main-session', 'ag-main'));
    expect(ok).toBe(true);
    // Queue is unchanged — main group never counted or enqueued.
    expect(getQueueStatus()).toMatchObject({
      activeNonMain: MAX_CONCURRENT_CONTAINERS,
      waiting: 0,
    });
  });

  it('never adds the main group session to the waiting queue', async () => {
    await Promise.all(Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => wakeOrQueue(makeSession(`s${i}`))));
    isMainGroupMock.mockReturnValue(true);
    await wakeOrQueue(makeSession('main-1', 'ag-main'));
    await wakeOrQueue(makeSession('main-2', 'ag-main'));
    expect(getQueueStatus().waiting).toBe(0);
  });
});

// ── rule SessionQueued ────────────────────────────────────────────────────────

describe('SessionQueued — cap full', () => {
  async function fillCap() {
    await Promise.all(Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => wakeOrQueue(makeSession(`cap${i}`))));
  }

  it('returns false and enqueues when cap is full', async () => {
    await fillCap();
    const ok = await wakeOrQueue(makeSession('waiter-1'));
    expect(ok).toBe(false);
    expect(getQueueStatus()).toMatchObject({ waiting: 1 });
    // Inner wake not called for the queued session.
    expect(fakeWake).toHaveBeenCalledTimes(MAX_CONCURRENT_CONTAINERS);
  });

  it('enqueues multiple sessions when cap is full', async () => {
    await fillCap();
    await wakeOrQueue(makeSession('w1'));
    await wakeOrQueue(makeSession('w2'));
    await wakeOrQueue(makeSession('w3'));
    expect(getQueueStatus().waiting).toBe(3);
  });

  // invariant AtMostOneWaitingEntryPerSession
  it('does not double-enqueue the same session (AtMostOneWaitingEntryPerSession)', async () => {
    await fillCap();
    const s = makeSession('dup');
    await wakeOrQueue(s);
    await wakeOrQueue(s); // second call — must be idempotent
    expect(getQueueStatus().waiting).toBe(1);
  });
});

// ── rule ContainerSlotFreed ───────────────────────────────────────────────────

describe('ContainerSlotFreed — FIFO drain on container exit', () => {
  async function fillCapAndQueue(queueCount: number): Promise<Session[]> {
    await Promise.all(Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => wakeOrQueue(makeSession(`cap${i}`))));
    const waiters: Session[] = [];
    for (let i = 0; i < queueCount; i++) {
      const s = makeSession(`w${i}`);
      waiters.push(s);
      await wakeOrQueue(s);
    }
    return waiters;
  }

  it('dequeues and wakes the next waiting session when a slot frees', async () => {
    const [waiter] = await fillCapAndQueue(1);
    fakeWake.mockClear();

    _simulateContainerExitForTesting('cap0');

    await Promise.resolve(); // let microtasks settle
    expect(fakeWake).toHaveBeenCalledOnce();
    expect(fakeWake).toHaveBeenCalledWith(waiter);
    expect(getQueueStatus()).toMatchObject({ activeNonMain: MAX_CONCURRENT_CONTAINERS, waiting: 0 });
  });

  it('dequeues in FIFO order — earliest queued_at woken first', async () => {
    const [first, second, third] = await fillCapAndQueue(3);
    fakeWake.mockClear();

    _simulateContainerExitForTesting('cap0');
    await Promise.resolve();

    // Only one slot freed — only the first waiter should be woken.
    expect(fakeWake).toHaveBeenCalledOnce();
    expect(fakeWake).toHaveBeenCalledWith(first);
    expect(getQueueStatus().waiting).toBe(2);

    fakeWake.mockClear();
    _simulateContainerExitForTesting('cap1');
    await Promise.resolve();

    expect(fakeWake).toHaveBeenCalledWith(second);
    fakeWake.mockClear();
    _simulateContainerExitForTesting('cap2');
    await Promise.resolve();
    expect(fakeWake).toHaveBeenCalledWith(third);
    expect(getQueueStatus().waiting).toBe(0);

    // Suppress unused-variable warnings from linter.
    void [second, third];
  });

  it('fills multiple slots when several containers exit simultaneously', async () => {
    await fillCapAndQueue(3);
    fakeWake.mockClear();

    // Simulate two exits.
    _simulateContainerExitForTesting('cap0');
    _simulateContainerExitForTesting('cap1');
    await Promise.resolve();

    expect(fakeWake).toHaveBeenCalledTimes(2);
    expect(getQueueStatus().waiting).toBe(1);
  });

  it('does nothing when the queue is empty on container exit', async () => {
    await wakeOrQueue(makeSession('s1'));
    fakeWake.mockClear();

    _simulateContainerExitForTesting('s1');
    await Promise.resolve();

    expect(fakeWake).not.toHaveBeenCalled();
    expect(getQueueStatus()).toMatchObject({ activeNonMain: 0, waiting: 0 });
  });
});

// ── invariant ActiveContainerLimit ────────────────────────────────────────────

describe('invariant ActiveContainerLimit — non-main active <= cap', () => {
  it('never exceeds cap regardless of concurrent wakeOrQueue calls', async () => {
    // Fire cap+5 concurrent wakeOrQueue calls.
    const extra = 5;
    await Promise.all(
      Array.from({ length: MAX_CONCURRENT_CONTAINERS + extra }, (_, i) => wakeOrQueue(makeSession(`s${i}`))),
    );
    const { activeNonMain, waiting } = getQueueStatus();
    expect(activeNonMain).toBe(MAX_CONCURRENT_CONTAINERS);
    expect(waiting).toBe(extra);
    // Invariant holds.
    expect(activeNonMain).toBeLessThanOrEqual(MAX_CONCURRENT_CONTAINERS);
  });
});

// ── rule StuckSessionRecovered ────────────────────────────────────────────────
// The spec requires: when a stuck session has work and the queue is empty
// (or it's the main group), it transitions directly back to processing.
// In wakeOrQueue terms: after the stuck container's slot is released and no
// waiters have claimed it, calling wakeOrQueue on the recovered session
// immediately wakes it.

describe('StuckSessionRecovered — re-wakes when queue is empty', () => {
  it('wakes immediately when the cap has a free slot after the stuck container exits', async () => {
    const stuck = makeSession('stuck-1');
    await wakeOrQueue(stuck);
    fakeWake.mockClear();

    // Simulate the stuck container being killed (releases slot).
    _simulateContainerExitForTesting(stuck.id);

    // No other waiters — wakeOrQueue should find a free slot.
    const ok = await wakeOrQueue(stuck);
    expect(ok).toBe(true);
    expect(fakeWake).toHaveBeenCalledOnce();
  });
});

// ── rule StuckSessionQueued ───────────────────────────────────────────────────
// The spec requires: when a stuck session has work but there are sessions
// already in the waiting queue, the stuck session goes to the back (not ahead).
// wakeOrQueue enqueues it at the tail, preserving FIFO order.

describe('StuckSessionQueued — stuck goes to back of queue when waiters exist', () => {
  it('stuck session is enqueued behind existing waiters', async () => {
    // Fill cap and add one waiter.
    await Promise.all(Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => wakeOrQueue(makeSession(`cap${i}`))));
    const prior = makeSession('prior-waiter');
    await wakeOrQueue(prior);
    expect(getQueueStatus().waiting).toBe(1);

    // Now a "stuck" session tries to re-enter after its container was killed.
    const stuck = makeSession('stuck-2');
    const ok = await wakeOrQueue(stuck);
    expect(ok).toBe(false);
    expect(getQueueStatus().waiting).toBe(2);

    fakeWake.mockClear();
    // Free one slot — the prior waiter (not the stuck one) should be woken first.
    _simulateContainerExitForTesting('cap0');
    await Promise.resolve();

    expect(fakeWake).toHaveBeenCalledWith(prior);
    expect(fakeWake).not.toHaveBeenCalledWith(stuck);
  });
});

// ── wake failure releases the slot ───────────────────────────────────────────

describe('wake failure handling', () => {
  it('releases the reserved slot when the inner wake fails, then drains waiters', async () => {
    // Queue one waiter at cap.
    await Promise.all(Array.from({ length: MAX_CONCURRENT_CONTAINERS }, (_, i) => wakeOrQueue(makeSession(`cap${i}`))));
    const waiter = makeSession('w1');
    await wakeOrQueue(waiter);
    expect(getQueueStatus().waiting).toBe(1);

    // The next non-main session tries to wake but the inner spawn fails.
    fakeWake.mockClear();
    _setWakeImplForTesting(fakeWakeFail);
    _simulateContainerExitForTesting('cap0');
    await Promise.resolve();

    // The failing wake must have released its slot and let the waiter retry.
    // The waiter is dequeued even if its own wake also fails — slot is released
    // back to 0 for that failed session, giving the waiter a chance.
    expect(fakeWakeFail).toHaveBeenCalled();
    // Queue is drained regardless of wake outcome.
    expect(getQueueStatus().waiting).toBe(0);
  });
});
