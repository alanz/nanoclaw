/**
 * todo — read and change Alan's todo list.
 *
 * The list lives in a WebXDC app in the DeltaChat chat (`/todo`); the host
 * keeps the merged list (src/modules/todo) and a readable copy at
 * /workspace/agent/todo/list.md. A change made here is merged on the host and
 * pushed into the app; it shows there at once if the app is open, otherwise
 * the next time `/todo` sends it.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { findCliResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HOST_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

async function askHost(
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const requestId = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action: 'todo_request', requestId, ...request }),
  });
  const deadline = Date.now() + HOST_TIMEOUT_MS;
  while (Date.now() < deadline && !signal?.aborted) {
    const row = findCliResponse(requestId);
    if (row) {
      markCompleted([row.id]);
      return JSON.parse(row.content) as Record<string, unknown>;
    }
    try {
      await sleep(POLL_MS, undefined, { signal });
    } catch {
      return null;
    }
  }
  return null;
}

export const todoTool: McpToolDefinition = {
  tool: {
    name: 'todo',
    description:
      "Read or change Alan's todo list (the list in his DeltaChat Todo app; he opens it with /todo). " +
      'action "list" returns the items with their ids; "add" needs text (optional section); ' +
      '"done", "undone" and "delete" need the item id; "edit" needs the id and new text and/or section. ' +
      'A change shows in the app at once when it is open (inApp: true), otherwise the next time he sends /todo. ' +
      'You can also read /workspace/agent/todo/list.md, a copy kept current by the host — never edit that file.',
    inputSchema: {
      type: 'object' as const,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'done', 'undone', 'edit', 'delete'] },
        id: { type: 'string', description: 'Item id, from list (for done, undone, edit, delete).' },
        text: { type: 'string', description: 'Item text (add, edit).' },
        section: { type: 'string', description: 'Optional section, e.g. "Shopping"; "" for none.' },
      },
    },
  },
  async handler(args, context) {
    // `action` names the host action (todo_request); the list operation travels as todoAction.
    const answer = await askHost(
      { todoAction: args.action, id: args.id, text: args.text, section: args.section },
      context?.signal,
    );
    if (!answer) {
      return { content: [{ type: 'text' as const, text: 'Error: the host did not answer in time.' }], isError: true };
    }
    const { type: _type, requestId: _id, ...rest } = answer;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(rest) }],
      ...(answer.ok === false ? { isError: true } : {}),
    };
  },
};

registerTools([todoTool]);
