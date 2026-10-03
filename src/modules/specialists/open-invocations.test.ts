/**
 * Which invocation a running container holds is kept in memory, so a host
 * restart forgot it: an adopted container's exit then ended nothing, and its
 * invocation stayed open — forever, for a session that never runs again
 * (two from August were found open on this install). At host start, after
 * adoption, running containers get their invocation back and every other
 * open invocation is ended.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  starts: [] as Array<() => Promise<void> | void>,
  exits: [] as Array<(e: { sessionId: string }) => void>,
  running: new Set<string>(['sess-adopted']),
  open: [
    { id: 'inv-adopted', session_id: 'sess-adopted' },
    { id: 'inv-orphan', session_id: 'sess-gone' },
  ],
}));

vi.mock('../../host-lifecycle.js', () => ({
  onHostStart: (cb: () => Promise<void> | void) => h.starts.push(cb),
  onHostShutdown: vi.fn(),
}));
vi.mock('../../container-runner.js', () => ({
  registerSessionContributor: vi.fn(),
  registerSessionExitHook: (hook: (e: { sessionId: string }) => void) => h.exits.push(hook),
  isContainerRunning: (id: string) => h.running.has(id),
}));
vi.mock('../../db/index.js', () => ({
  getDb: () => ({
    hasTable: async () => true,
    all: async (sql: string) => (sql.includes('FROM invocations') ? h.open : []),
  }),
}));
vi.mock('../../delivery.js', () => ({ registerDeliveryAction: vi.fn(), deliverSessionMessages: vi.fn() }));
vi.mock('../../db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/sessions.js')>()),
  getSession: vi.fn(async (id: string) => ({ id, agent_group_id: 'ag-1', thread_id: null })),
}));
vi.mock('./invocation.js', () => ({
  buildInvocationForSession: vi.fn(),
  endInvocationById: vi.fn(async () => {}),
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
  reclaimTransferStaging: vi.fn(),
  sweepTransferStaging: vi.fn(async () => 0),
  sweepInvocationDirs: vi.fn(async () => 0),
}));

import { endInvocationById } from './invocation.js';
import './index.js';

describe('open invocations at host start', () => {
  it('ends those with no container and re-registers adopted ones so their exit ends them', async () => {
    for (const start of h.starts) await start();

    expect(endInvocationById).toHaveBeenCalledWith('inv-orphan');
    expect(endInvocationById).not.toHaveBeenCalledWith('inv-adopted');

    for (const exit of h.exits) exit({ sessionId: 'sess-adopted' });
    await vi.waitFor(() => expect(endInvocationById).toHaveBeenCalledWith('inv-adopted'));
  });
});
