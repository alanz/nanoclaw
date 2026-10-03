import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getContinuation } from './db/session-state.js';
import { runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import { clearShutdownRequest, isShutdownRequested, requestShutdown } from './shutdown.js';

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
});
