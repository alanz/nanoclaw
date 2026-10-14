/**
 * The todo tool: asks the host (todo_request) and returns its answer; the
 * host owns the list (src/modules/todo).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { todoTool } from './todo.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

function request(): Record<string, unknown> | undefined {
  const row = getUndeliveredMessages().find((m) => m.kind === 'system');
  return row && JSON.parse(row.content);
}

async function hostAnswers(reply: (requestId: string) => Record<string, unknown>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const req = request();
    if (req) {
      const content = reply(req.requestId as string);
      getInboundDb()
        .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
        .run(`todo-resp-${content.requestId}`, 'system', new Date().toISOString(), JSON.stringify(content));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no todo_request written');
}

describe('todo tool', () => {
  it("sends the action to the host and returns the host's answer", async () => {
    const call = todoTool.handler({ action: 'add', text: 'Renew passport', section: 'Admin' });
    await hostAnswers((requestId) => ({
      type: 'todo_response',
      requestId,
      ok: true,
      inApp: true,
      item: { id: 'k1', text: 'Renew passport' },
    }));
    const result = await call;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      ok: true,
      inApp: true,
      item: { id: 'k1', text: 'Renew passport' },
    });
    expect(request()).toMatchObject({
      action: 'todo_request',
      todoAction: 'add',
      text: 'Renew passport',
      section: 'Admin',
    });
  });

  it("reports the host's refusal as an error", async () => {
    const call = todoTool.handler({ action: 'done', id: 'nope' });
    await hostAnswers((requestId) => ({
      type: 'todo_response',
      requestId,
      ok: false,
      error: 'no item nope on the list',
    }));
    const result = await call;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('no item nope');
  });
});
