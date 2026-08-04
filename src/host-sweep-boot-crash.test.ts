/**
 * Regression tests for the give-up path on a container that cannot start.
 *
 * A container that dies during boot never claims a message, so the MAX_TRIES
 * retry ladder (which only walks processing_ack claims) never engages. Before
 * this path existed the sweep simply respawned once a minute forever and the
 * person who sent the message got silence — the specialist equivalent ran 241
 * times across 4 hours.
 *
 * Drives the real sweep loop against real on-disk session DBs, mocking only
 * the container runner and the delivery adapter. Goes red if the give-up check
 * is removed, or if it stops running BEFORE the wake.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-boot-crash' };
});

vi.mock('./container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeOrQueue: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  getBootCrashState: vi.fn().mockReturnValue({ count: 0, stderrTail: [] }),
  clearBootCrashState: vi.fn(),
}));

const deliver = vi.fn().mockResolvedValue(undefined);
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: vi.fn(() => ({ deliver })),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from './db/index.js';
import { createSession } from './db/sessions.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { clearBootCrashState, getBootCrashState, wakeOrQueue } from './container-runner.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { initSessionFolder, openInboundDb, writeSessionMessage } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-boot-crash';
const AG = 'ag-test';
const SESS = 'sess-test';
const MG = 'mg-test';
const SWEEP_INTERVAL_MS = 60_000;

function now(): string {
  return new Date().toISOString();
}

const sweepCallbacks: Array<() => void> = [];
const realSetTimeout = global.setTimeout;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

async function runSweepTick(): Promise<void> {
  const before = sweepCallbacks.length;
  if (before === 0) startHostSweep();
  else sweepCallbacks[before - 1]();
  await vi.waitFor(() => {
    expect(sweepCallbacks.length).toBe(before + 1);
  });
}

function messageStatuses(): string[] {
  const db = openInboundDb(AG, SESS);
  try {
    return (db.prepare('SELECT status FROM messages_in').all() as Array<{ status: string }>).map((r) => r.status);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  vi.mocked(wakeOrQueue).mockReset().mockResolvedValue(true);
  vi.mocked(getBootCrashState).mockReset().mockReturnValue({ count: 0, stderrTail: [] });
  vi.mocked(clearBootCrashState).mockReset();
  deliver.mockReset().mockResolvedValue(undefined);

  sweepCallbacks.length = 0;
  setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === SWEEP_INTERVAL_MS) {
      sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: AG, name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: MG,
    channel_type: 'testchan',
    platform_id: 'chat-1',
    name: 'Test Chat',
    is_group: 0,
    instance: 'testchan',
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: MG,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(AG, SESS);
  writeSessionMessage(AG, SESS, { id: 'm-1', kind: 'chat', timestamp: now(), content: '{"text":"hi"}' });
});

afterEach(() => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('host sweep — container that cannot start', () => {
  it('keeps waking while the crash streak is short', async () => {
    // Below the threshold a fast exit may be transient (image pull, host
    // hiccup) — the sweep must keep trying, not give up on the first stumble.
    vi.mocked(getBootCrashState).mockReturnValue({ count: 2, stderrTail: ['boom'] });

    await runSweepTick();

    expect(wakeOrQueue).toHaveBeenCalled();
    expect(messageStatuses()).toEqual(['pending']);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('stops respawning and fails queued messages once the streak is conclusive', async () => {
    vi.mocked(getBootCrashState).mockReturnValue({
      count: 3,
      stderrTail: ['[agent-runner] Fatal error: EROFS: read-only file system'],
    });

    await runSweepTick();

    // The give-up check must run BEFORE the wake: spawning attempt N+1 only
    // buys another crash and another minute of silence.
    expect(wakeOrQueue).not.toHaveBeenCalled();
    // Pending work is failed so countDueMessages drops to zero and the wake
    // path stops firing on subsequent ticks.
    expect(messageStatuses()).toEqual(['failed']);
    expect(clearBootCrashState).toHaveBeenCalledWith(SESS);
  });

  it('tells the originating chat, with the reason', async () => {
    // The container is the only writer of outbound.db, so one that never
    // starts cannot apologise for itself — the host must send this directly.
    vi.mocked(getBootCrashState).mockReturnValue({
      count: 3,
      stderrTail: ['[agent-runner] Fatal error: EROFS: read-only file system'],
    });

    await runSweepTick();

    expect(deliver).toHaveBeenCalledTimes(1);
    const [channelType, platformId, , kind, content] = deliver.mock.calls[0];
    expect(channelType).toBe('testchan');
    expect(platformId).toBe('chat-1');
    expect(kind).toBe('chat');
    expect(JSON.parse(content as string).text).toContain('EROFS');
  });

  it('does not wake again on the following tick', async () => {
    vi.mocked(getBootCrashState).mockReturnValue({ count: 3, stderrTail: ['boom'] });
    await runSweepTick();

    // Streak cleared, but the messages are terminal — nothing is due, so the
    // loop is genuinely over rather than merely paused.
    vi.mocked(getBootCrashState).mockReturnValue({ count: 0, stderrTail: [] });
    await runSweepTick();

    expect(wakeOrQueue).not.toHaveBeenCalled();
  });

  it('survives a session with no messaging group', async () => {
    // System task sessions and agent_shared inboxes have no one to notify;
    // the work must still be failed rather than looping forever.
    getDb().prepare('UPDATE sessions SET messaging_group_id = NULL WHERE id = ?').run(SESS);
    vi.mocked(getBootCrashState).mockReturnValue({ count: 3, stderrTail: ['boom'] });

    await runSweepTick();

    expect(messageStatuses()).toEqual(['failed']);
    expect(deliver).not.toHaveBeenCalled();
  });
});
