/**
 * Boot-crash detection and bounded failure.
 *
 * The discriminator under test is lifetime, not exit code: these pin that a
 * container which died on the way up is counted, one that worked first is
 * not, and that the loop ends in a reported failure rather than in silence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hooks, mockDeliver, mockFailPending, mockSession, mockMg } = vi.hoisted(() => ({
  hooks: [] as Array<(e: unknown) => void>,
  mockDeliver: vi.fn(
    async (
      _channelType: string,
      _platformId: string,
      _threadId: string | null,
      _kind: string,
      _content: string,
      _files?: unknown,
      _instance?: string,
    ) => 'msg-1' as string | undefined,
  ),
  mockFailPending: vi.fn(() => 2),
  mockSession: vi.fn(
    async () =>
      ({
        id: 's1',
        agent_group_id: 'g1',
        messaging_group_id: 'mg1',
        thread_id: null,
      }) as unknown,
  ),
  mockMg: vi.fn(async () => ({ channel_type: 'deltachat', platform_id: 'dc:7', instance: 'deltachat' }) as unknown),
}));

vi.mock('../../container-runner.js', () => ({
  registerSessionExitHook: (hook: (e: unknown) => void) => hooks.push(hook),
}));
vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver: mockDeliver }) }));
vi.mock('../../db/messaging-groups.js', () => ({ getMessagingGroup: mockMg }));
vi.mock('../../db/sessions.js', () => ({ getSession: mockSession }));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (_g: string, _s: string, action: (m: unknown) => unknown) =>
    action({ failPendingMessages: mockFailPending }),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { getBootCrashState, registerBootCrashExemption, resetBootCrashStateForTesting } from './index.js';

/** One container exit, as container-runner's finish() reports it. */
function exit(
  over: Partial<{
    sessionId: string;
    ranMs: number;
    adopted: boolean;
    exitCode: number | undefined;
    stderrTail: string[];
  }> = {},
): void {
  const { sessionId = 's1', ranMs = 800, adopted = false, stderrTail = ['EROFS: read-only file system'] } = over;
  // `in`, not a default: a default also fires for an explicit undefined, and
  // "killed by signal" is exactly the explicit-undefined case.
  const exitCode = 'exitCode' in over ? over.exitCode : 1;
  const event = {
    sessionId,
    ranMs,
    adopted,
    failure: exitCode === undefined ? undefined : { kind: 'started-then-died', retryable: false, exitCode, stderrTail },
  };
  for (const hook of hooks) hook(event);
}

async function settled(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  resetBootCrashStateForTesting();
  mockDeliver.mockClear();
  mockFailPending.mockClear();
  mockFailPending.mockImplementation(() => 2);
});

describe('what counts as a boot crash', () => {
  it('counts a fast non-zero exit', () => {
    exit({ ranMs: 800 });
    expect(getBootCrashState('s1').count).toBe(1);
  });

  it('does not count an exit that ran real work first', () => {
    // A container that worked and then failed is a different event with a
    // different remedy; the retry machinery already covers it.
    exit({ ranMs: 60_000 });
    expect(getBootCrashState('s1').count).toBe(0);
  });

  it('does not count a clean exit', () => {
    exit({ exitCode: 0 });
    expect(getBootCrashState('s1').count).toBe(0);
  });

  it('does not count a signal kill — that is a normal shutdown', () => {
    exit({ exitCode: undefined });
    expect(getBootCrashState('s1').count).toBe(0);
  });

  it('does not count an adopted container, whose start this host never saw', () => {
    exit({ adopted: true });
    expect(getBootCrashState('s1').count).toBe(0);
  });

  it('requires the crashes to be consecutive', () => {
    exit();
    exit();
    expect(getBootCrashState('s1').count).toBe(2);
    exit({ exitCode: 0 });
    expect(getBootCrashState('s1').count).toBe(0);
  });

  it('counts per session, not globally', () => {
    exit({ sessionId: 'a' });
    exit({ sessionId: 'b' });
    expect(getBootCrashState('a').count).toBe(1);
    expect(getBootCrashState('b').count).toBe(1);
  });

  it('keeps the last crash stderr, which is the only place the reason exists', () => {
    exit({ stderrTail: ['EACCES: permission denied'] });
    expect(getBootCrashState('s1').stderrTail).toEqual(['EACCES: permission denied']);
  });
});

describe('at the threshold', () => {
  it('does not act before three consecutive crashes', async () => {
    exit();
    exit();
    await settled();
    expect(mockFailPending).not.toHaveBeenCalled();
  });

  it('ends the pending work and reports why', async () => {
    exit();
    exit();
    exit();
    await settled();

    expect(mockFailPending).toHaveBeenCalled();
    const text = mockDeliver.mock.calls[0][4];
    expect(text).toContain('EROFS: read-only file system');
    expect(text).toContain('2 pending messages');
  });

  it('clears the count so a later retry starts clean', async () => {
    exit();
    exit();
    exit();
    await settled();
    expect(getBootCrashState('s1').count).toBe(0);
  });

  it('says nothing when there was no pending work to end', async () => {
    mockFailPending.mockImplementation(() => 0);
    exit();
    exit();
    exit();
    await settled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('defers to an owner that claims the session', async () => {
    // A specialist's crash loop is failed by its own recovery sweep, which
    // routes the reason back to the requesting agent; acting here would race
    // that and strip the reporting.
    registerBootCrashExemption((sessionId) => sessionId === 's1');
    exit();
    exit();
    exit();
    await settled();
    expect(mockFailPending).not.toHaveBeenCalled();
  });
});
