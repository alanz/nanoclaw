import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getContinuation } from './db/session-state.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import { clearShutdownRequest, disarmHandoffExit, isShutdownRequested, requestShutdown } from './shutdown.js';

// dispatch_sub_task and deliver_specialist_result run in the MCP server, a
// separate process from the poll loop. The pre-rebuild flag lived in module
// memory, so the request never reached the loop and no specialist container
// ever exited on it — the parent held its concurrency slot for the whole
// sub-task.

let dir: string;
const saved = { marker: process.env.NANOCLAW_SHUTDOWN_MARKER, specialist: process.env.NANOCLAW_SPECIALIST };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-shutdown-'));
  process.env.NANOCLAW_SHUTDOWN_MARKER = path.join(dir, 'marker');
  process.env.NANOCLAW_SPECIALIST = '1';
  initTestSessionDb();
});

afterEach(() => {
  // A loop a test stops by its abort signal never reaches the normal return
  // that disarms the hand-off exit; never let one test's timer reach the next.
  disarmHandoffExit();
  closeSessionDb();
  process.env.NANOCLAW_SHUTDOWN_MARKER = saved.marker;
  process.env.NANOCLAW_SPECIALIST = saved.specialist;
  if (saved.marker === undefined) delete process.env.NANOCLAW_SHUTDOWN_MARKER;
  if (saved.specialist === undefined) delete process.env.NANOCLAW_SPECIALIST;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Call requestShutdown() from another process, as the MCP server does. */
function requestFromChild(env: Record<string, string>): void {
  const script = `import { requestShutdown } from ${JSON.stringify(path.join(import.meta.dir, 'shutdown.ts'))}; requestShutdown();`;
  const child = Bun.spawnSync(['bun', '-e', script], {
    env: { ...process.env, NANOCLAW_SHUTDOWN_MARKER: process.env.NANOCLAW_SHUTDOWN_MARKER!, ...env },
  });
  expect(child.exitCode).toBe(0);
}

describe('shutdown request', () => {
  it('reaches this process when raised in another one', () => {
    expect(isShutdownRequested()).toBe(false);
    requestFromChild({ NANOCLAW_SPECIALIST: '1' });
    expect(isShutdownRequested()).toBe(true);
    clearShutdownRequest();
    expect(isShutdownRequested()).toBe(false);
  });

  it('is ignored outside a specialist container', () => {
    requestFromChild({ NANOCLAW_SPECIALIST: '' });
    expect(isShutdownRequested()).toBe(false);
  });

  it('ends the poll loop after the turn that raised it, keeping the conversation', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'agent', ?)`,
      )
      .run(JSON.stringify({ sender: 'Requester', text: 'research this' }));

    // The turn's tool call (dispatch_sub_task) raises the request mid-turn.
    const provider = new MockProvider({}, () => {
      requestShutdown();
      return 'Sub-task dispatched; ending my turn.';
    });

    // Safety net only: a loop that ignores the request would otherwise poll forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const returned = await runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal }).then(
      () => !controller.signal.aborted,
    );
    clearTimeout(timer);

    expect(returned).toBe(true);
    // Persisted, so the sub-task's result resumes this conversation.
    expect(getContinuation('mock')).toMatch(/^mock-session-/);
  });

  // Live run 2026-10-03: the Researcher ended its turn with an unwrapped line
  // after dispatch_sub_task; the wrap-nudge opened a 2-minute retry turn that
  // kept the container (and its slot) while the sub-task ran.
  it('does not wrap-nudge a specialist that has asked to exit', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'agent', ?)`,
      )
      .run(JSON.stringify({ sender: 'Requester', text: 'research this' }));

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      requestShutdown();
      return 'Dispatched the code question to the Coder; ending this turn.'; // unwrapped
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const returned = await runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal }).then(
      () => !controller.signal.aborted,
    );
    clearTimeout(timer);

    expect(returned).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts.some((p) => p.includes('was not delivered'))).toBe(false);
  });

  // Live run 2026-10-03 (second): a rejected first dispatch cancelled the
  // request, the turn then ended unwrapped, and the nudge fired anyway — the
  // Researcher called it "a spurious or injected instruction". A specialist
  // has no destinations and reports through its tools: never nudge it.
  it('never wrap-nudges a specialist, shutdown requested or not', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'agent', ?)`,
      )
      .run(JSON.stringify({ sender: 'Requester', text: 'research this' }));

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return 'Some unwrapped working notes.';
    });

    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await loop;

    expect(prompts).toHaveLength(1);
    expect(prompts.some((p) => p.includes('was not delivered'))).toBe(false);
  });

  // The real SDK need not end its event stream promptly on abort, and leaving
  // the poll loop waits for it. A hand-off must still end the process.
  it('exits the process after a hand-off even if the provider stream never ends', async () => {
    process.env.NANOCLAW_HANDOFF_EXIT_GRACE_MS = '50';
    const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
           VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'agent', ?)`,
        )
        .run(JSON.stringify({ sender: 'Requester', text: 'research this' }));

      // A turn that hands off, then a stream whose close never completes —
      // the shape of a provider whose cleanup waits on a subprocess. Leaving
      // the poll loop's `for await` awaits that close.
      class StuckProvider extends MockProvider {
        override query(_input: QueryInput): AgentQuery {
          const script: ProviderEvent[] = [
            { type: 'init', continuation: 'stuck-session' },
            { type: 'result', text: 'Handed off.' },
          ];
          const iterator: AsyncIterator<ProviderEvent> = {
            async next() {
              const event = script.shift();
              if (!event) return new Promise(() => {}); // never another event
              if (event.type === 'result') requestShutdown();
              return { value: event, done: false };
            },
            return: () => new Promise(() => {}), // close never completes
          };
          return {
            push: () => {},
            end: () => {},
            abort: () => {},
            events: { [Symbol.asyncIterator]: () => iterator },
          };
        }
      }

      void runPollLoop({ provider: new StuckProvider(), providerName: 'mock', cwd: '/tmp' });
      const start = Date.now();
      while (exit.mock.calls.length === 0) {
        if (Date.now() - start > 3000) throw new Error('process.exit was never called');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
      disarmHandoffExit();
      delete process.env.NANOCLAW_HANDOFF_EXIT_GRACE_MS;
    }
  });

  // The request is raised when the tool is called, before the host has looked
  // at the dispatch. If the host rejects it, its notice arrives after the
  // request: exiting then would leave the task `running` with no container.
  it('stays to answer a message that arrives after the request', async () => {
    const insert = (id: string, text: string) =>
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
           VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'agent', ?)`,
        )
        .run(id, JSON.stringify({ sender: 'system', text }));
    insert('m1', 'research this');

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        requestShutdown(); // dispatch_sub_task
        insert('m2', 'dispatch_sub_task failed: not a specialist'); // the host's rejection
      }
      return 'ok';
    });

    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
    const start = Date.now();
    while (!prompts.some((p) => p.includes('dispatch_sub_task failed'))) {
      if (Date.now() - start > 5000) throw new Error('rejection notice never reached the agent');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort();
    await loop;

    expect(isShutdownRequested()).toBe(false);
  });
});
