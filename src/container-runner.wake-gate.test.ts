/**
 * The wake gate's hand-back contract, through the real `wakeContainer`.
 *
 * A gate that reserves capacity at admission must get every admission back.
 * A wake that registers a runtime gives it back through the session-exit hook;
 * one that never registers a runtime fires no exit event, so `wakeContainer`
 * must give it back through the gate's release — or the capacity is gone for
 * good, one unit per failed spawn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';

const snapshots: SupervisedSnapshot[] = [];
vi.mock('./drivers/index.js', () => ({
  getSessionDriver: () => ({
    listSessions: async () => snapshots,
    capabilities: () => ({}),
  }),
  isSessionEventsDriver: () => false,
}));

const { getAgentGroupOverride } = vi.hoisted(() => ({
  getAgentGroupOverride: { fn: null as null | ((id: string) => Promise<unknown>) },
}));
vi.mock('./db/agent-groups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/agent-groups.js')>();
  return {
    ...actual,
    getAgentGroup: (id: string) => (getAgentGroupOverride.fn ? getAgentGroupOverride.fn(id) : actual.getAgentGroup(id)),
  };
});

import {
  adoptRunningSessions,
  isContainerRunning,
  killContainer,
  setWakeGate,
  wakeContainer,
} from './container-runner.js';
import { createAgentGroup, createSession, closeDb, initTestDb, runMigrations } from './db/index.js';
import { type GatewaySessionInput, resetGatewayProvider } from './gateway-providers/index.js';
import type { Session } from './types.js';

const ensure = vi.fn(async (_input: GatewaySessionInput) => ({
  contribution: {
    networkAccess: { endpoint: 'http://proxy:8080', target: { kind: 'runtime' as const, identity: 'proxy' } },
  },
  release: async () => {},
}));

function now(): string {
  return new Date().toISOString();
}

function session(id = 'sess-1', agentGroupId = 'ag-1'): Session {
  return { id, agent_group_id: agentGroupId } as Session;
}

function fakeHandle(sessionId: string, name: string): SupervisedHandle {
  const terminalCallbacks: Array<(failure?: unknown) => void> = [];
  return {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId },
    name,
    async start() {},
    async stop() {
      for (const callback of terminalCallbacks) callback(undefined);
    },
    async status() {
      return { phase: 'running' };
    },
    onTerminal(callback: (failure?: unknown) => void) {
      terminalCallbacks.push(callback);
    },
  } as unknown as SupervisedHandle;
}

const admit = vi.fn(async (_session: Session) => true);
const release = vi.fn((_session: Session) => {});

beforeEach(async () => {
  snapshots.length = 0;
  getAgentGroupOverride.fn = null;
  admit.mockReset();
  admit.mockImplementation(async () => true);
  release.mockReset();
  resetGatewayProvider({
    kind: 'test-wake-gate',
    agentSkills: [],
    sessions: { ensure, reapOrphans: async () => {} },
    approvals: { subscribe: async () => {} },
  });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
  setWakeGate(admit, release);
});

afterEach(async () => {
  setWakeGate(null);
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  resetGatewayProvider();
  await closeDb();
});

describe('wake gate hand-back', () => {
  it('hands the admission back when the spawn throws before any runtime exists', async () => {
    getAgentGroupOverride.fn = async () => {
      throw new Error('database unavailable');
    };

    expect(await wakeContainer(session())).toBe(false);
    expect(admit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0][0]).toMatchObject({ id: 'sess-1' });
  });

  it('hands the admission back when the spawn returns without starting anything', async () => {
    // A session whose agent group is gone: spawnContainer logs and returns
    // without registering a runtime, so no exit event will ever fire.
    await wakeContainer(session('sess-orphan', 'ag-missing'));
    expect(admit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(isContainerRunning('sess-orphan')).toBe(false);
  });

  it('has nothing to hand back when the gate declines', async () => {
    admit.mockImplementation(async () => false);
    expect(await wakeContainer(session())).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it('neither admits nor releases for a session whose container is already running', async () => {
    snapshots.push({ handle: fakeHandle('sess-1', 'container-a'), phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    expect(isContainerRunning('sess-1')).toBe(true);

    expect(await wakeContainer(session())).toBe(true);
    expect(admit).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('keeps a wake failure a plain false when the release itself throws', async () => {
    getAgentGroupOverride.fn = async () => {
      throw new Error('database unavailable');
    };
    release.mockImplementation(() => {
      throw new Error('release bug');
    });
    await expect(wakeContainer(session())).resolves.toBe(false);
  });
});
