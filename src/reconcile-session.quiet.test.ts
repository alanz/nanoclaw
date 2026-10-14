/**
 * When a session counts as quiet (the turn over, so ✅ and the end-of-turn
 * cleanup fire). A long model call — writing a whole note in one tool call —
 * runs no tool and emits no stream event, so heartbeat and tool state alone
 * read it as finished (2026-10-14: ✅ before the reply). The runner's
 * turn-in-progress flag holds it.
 */
import { describe, expect, it, vi } from 'vitest';

const running = vi.hoisted(() => ({ value: true }));
vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  isContainerRunning: () => running.value,
}));
vi.mock('./session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-manager.js')>()),
  heartbeatPath: () => '/nonexistent/heartbeat', // no heartbeat: long silent
}));

import { _isSessionQuietForTesting as isSessionQuiet } from './reconcile-session.js';
import type { OutboundMailbox } from './mailbox/types.js';
import type { Session } from './types.js';

const session = { id: 'sess-q', agent_group_id: 'ag-q' } as Session;

function mailbox(over: { claims?: number; tool?: string | null; turn?: boolean }): OutboundMailbox {
  return {
    getProcessingClaims: () => Array.from({ length: over.claims ?? 0 }, () => ({})),
    getContainerState: () => (over.tool ? { currentTool: over.tool } : null),
    isTurnInProgress: () => over.turn ?? false,
  } as unknown as OutboundMailbox;
}

describe('isSessionQuiet', () => {
  it('is not quiet while a turn is in progress, however long since the last stream event', () => {
    running.value = true;
    expect(isSessionQuiet(mailbox({ turn: true }), session, 'ag-q')).toBe(false);
  });

  it('is quiet once the turn is over and the heartbeat is old', () => {
    running.value = true;
    expect(isSessionQuiet(mailbox({ turn: false }), session, 'ag-q')).toBe(true);
  });

  it('is quiet when no container runs, whatever its last recorded state', () => {
    running.value = false;
    expect(isSessionQuiet(mailbox({ turn: true, tool: 'Bash', claims: 1 }), session, 'ag-q')).toBe(true);
  });

  it('is not quiet while a tool runs or a message is claimed', () => {
    running.value = true;
    expect(isSessionQuiet(mailbox({ tool: 'Bash' }), session, 'ag-q')).toBe(false);
    expect(isSessionQuiet(mailbox({ claims: 1 }), session, 'ag-q')).toBe(false);
  });
});
