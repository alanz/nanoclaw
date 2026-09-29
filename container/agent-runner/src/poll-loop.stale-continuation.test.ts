import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, QueryInput } from './providers/types.js';
import { FAILURE_NOTICE_FIELD } from './formatter.js';

// A stored continuation whose conversation no longer exists fails at resume,
// before any output. The loop clears it and reruns the same batch once on a
// fresh session, so the turn is not lost to an "Error: No conversation found"
// reply. Seen live: a Zotero sync task silently dropped this way.

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

/** Fails any resume of a continuation in `staleIds`; otherwise behaves as MockProvider. */
class StaleResumeProvider extends MockProvider {
  readonly continuations: Array<string | undefined> = [];

  constructor(private readonly staleIds: Set<string | undefined>) {
    super({}, () => 'fresh reply');
  }

  override isSessionInvalid(err: unknown): boolean {
    return /no conversation found/i.test(err instanceof Error ? err.message : String(err));
  }

  override query(input: QueryInput): AgentQuery {
    this.continuations.push(input.continuation);
    if (!this.staleIds.has(input.continuation)) return super.query(input);
    const id = input.continuation;
    return {
      push: () => {},
      end: () => {},
      abort: () => {},
      events: (async function* () {
        throw new Error(`Claude Code returned an error result: No conversation found with session ID: ${id}`);
      })(),
    };
  }
}

function insertChat(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'User', text: 'sync the library' }));
}

/** Failure notices the loop sent (see FAILURE_NOTICE_FIELD). */
function errorReplies(): string[] {
  return getUndeliveredMessages()
    .map((m) => JSON.parse(m.content) as { text?: string } & Record<string, unknown>)
    .filter((c) => c[FAILURE_NOTICE_FIELD] === true)
    .map((c) => c.text ?? '');
}

async function runUntil(provider: MockProvider, done: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > 5000) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  controller.abort();
  await Promise.race([loop.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
}

describe('poll loop — stale continuation', () => {
  it('reruns the batch once on a fresh session instead of replying with the error', async () => {
    setContinuation('mock', 'gone-id');
    insertChat('m1');
    const provider = new StaleResumeProvider(new Set(['gone-id']));

    await runUntil(provider, () => provider.continuations.length >= 2 && getPendingMessages().length === 0);

    expect(provider.continuations.slice(0, 2)).toEqual(['gone-id', undefined]);
    expect(errorReplies()).toEqual([]);
    // The fresh session's id replaced the stale one.
    expect(getContinuation('mock')).toMatch(/^mock-session-/);
  });

  it('retries only once: a fresh session that also fails reports the error', async () => {
    setContinuation('mock', 'gone-id');
    insertChat('m1');
    // Even the fresh (undefined) resume "fails" — the loop must not spin.
    const provider = new StaleResumeProvider(new Set(['gone-id', undefined]));

    await runUntil(provider, () => errorReplies().length > 0);

    expect(provider.continuations).toEqual(['gone-id', undefined]);
    expect(errorReplies()).toHaveLength(1);
    expect(getPendingMessages()).toHaveLength(0);
  });
});
