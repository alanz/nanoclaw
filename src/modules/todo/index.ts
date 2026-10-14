/**
 * Todo list: Alan's list, kept in a WebXDC app (DeltaChat `/todo`) with the
 * agent as a participant.
 *
 * The list is a log of ops in the app (model.ts). This module keeps the
 * merged state per agent group — groups/<folder>/todo/state.json, rendered to
 * todo/list.md for the agent to read — and is the agent's way to change it:
 * the `todo` tool's request (todo_request) becomes an op merged here and
 * pushed into the app. Ops made in the app come back through the channel's
 * transport and merge the same way. The channel adapter only carries ops; it
 * registers a transport here and reports what the app sends.
 *
 * Changes made in the app are not announced to the agent (Alan, 2026-10-14):
 * it reads the list when it needs it.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  MAX_SECTION,
  MAX_TEXT,
  type TodoFields,
  type TodoOp,
  type TodoSnapshot,
  type TodoState,
  applyOp,
  applyPayload,
  newItemId,
  renderMarkdown,
  visibleItems,
} from './model.js';

/** Carries ops into a channel's todo app. False when that chat has no todo app open. */
export interface TodoTransport {
  push(platformId: string, payloads: unknown[]): Promise<boolean>;
}

const transports = new Map<string, TodoTransport>();

export function registerTodoTransport(channelType: string, transport: TodoTransport): void {
  transports.set(channelType, transport);
}

// ── State per agent group ────────────────────────────────────────────────────

function todoDir(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'todo');
}

function loadState(folder: string): TodoState {
  try {
    return JSON.parse(fs.readFileSync(path.join(todoDir(folder), 'state.json'), 'utf-8')) as TodoState;
  } catch {
    return {};
  }
}

function saveState(folder: string, state: TodoState): void {
  const dir = todoDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name: string, body: string) => {
    fs.writeFileSync(path.join(dir, `${name}.tmp`), body);
    fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name));
  };
  write('state.json', JSON.stringify(state));
  write('list.md', renderMarkdown(state, new Date().toISOString()));
}

/** One change at a time per group folder: read, merge, write. */
const queues = new Map<string, Promise<unknown>>();
function withState<T>(folder: string, fn: (state: TodoState) => { result: T; changed: boolean }): Promise<T> {
  const run = (queues.get(folder) ?? Promise.resolve()).then(() => {
    const state = loadState(folder);
    const { result, changed } = fn(state);
    if (changed) saveState(folder, state);
    return result;
  });
  queues.set(
    folder,
    run.catch(() => undefined),
  );
  return run;
}

/** The folders of the agent groups wired to a chat. */
async function foldersForChat(channelType: string, platformId: string): Promise<string[]> {
  const mg = await getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) return [];
  const folders: string[] = [];
  for (const w of await getMessagingGroupAgents(mg.id)) {
    const group = await getAgentGroup(w.agent_group_id);
    if (group) folders.push(group.folder);
  }
  return folders;
}

// ── From the app ─────────────────────────────────────────────────────────────

/** Merge what a chat's todo app sent (its users' ops and the bot's own echo alike). */
export async function todoUpdatesFromApp(channelType: string, platformId: string, payloads: unknown[]): Promise<void> {
  for (const folder of await foldersForChat(channelType, platformId)) {
    await withState(folder, (state) => {
      let changed = false;
      for (const p of payloads) if (applyPayload(state, p)) changed = true;
      return { result: undefined, changed };
    });
  }
}

/** The whole list, to seed a freshly sent app (a new WebXDC instance starts empty). */
export async function todoSnapshotFor(channelType: string, platformId: string): Promise<TodoSnapshot> {
  const [folder] = await foldersForChat(channelType, platformId);
  const state = folder ? loadState(folder) : {};
  return { type: 'todo_snapshot', items: Object.values(state) };
}

// ── The agent's todo tool ────────────────────────────────────────────────────

type TodoAction = 'list' | 'add' | 'done' | 'undone' | 'edit' | 'delete';

interface TodoAnswer {
  ok: boolean;
  error?: string;
  items?: ReturnType<typeof visibleItems>;
  item?: ReturnType<typeof visibleItems>[number];
  /** Whether the change reached an open todo app now (else it shows when one is next sent). */
  inApp?: boolean;
}

/** Push an op to every DM of the group whose channel has a todo app. */
async function pushToApps(agentGroupId: string, op: TodoOp): Promise<boolean> {
  let pushed = false;
  for (const mg of await getMessagingGroupsByAgentGroup(agentGroupId)) {
    const transport = transports.get(mg.channel_type);
    if (!transport || mg.is_group) continue;
    try {
      if (await transport.push(mg.platform_id, [op])) pushed = true;
    } catch (err) {
      log.warn('Todo: push to the app failed', { platformId: mg.platform_id, err });
    }
  }
  return pushed;
}

export async function handleTodoRequest(agentGroupId: string, req: Record<string, unknown>): Promise<TodoAnswer> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return { ok: false, error: 'unknown agent group' };
  const action = req.action as TodoAction;
  const id = typeof req.id === 'string' ? req.id : undefined;
  const text = typeof req.text === 'string' ? req.text.trim().slice(0, MAX_TEXT) : undefined;
  const section = typeof req.section === 'string' ? req.section.trim().slice(0, MAX_SECTION) : undefined;

  if (action === 'list') {
    return { ok: true, items: visibleItems(loadState(group.folder)) };
  }

  let set: TodoFields;
  let itemId: string;
  switch (action) {
    case 'add':
      if (!text) return { ok: false, error: 'add needs text' };
      itemId = newItemId();
      set = { text, done: false, ...(section !== undefined ? { section } : {}) };
      break;
    case 'done':
    case 'undone':
    case 'edit':
    case 'delete': {
      if (!id) return { ok: false, error: `${action} needs the item id (from list)` };
      const current = visibleItems(loadState(group.folder)).find((i) => i.id === id);
      if (!current) return { ok: false, error: `no item ${id} on the list` };
      itemId = id;
      if (action === 'edit') {
        if (text === undefined && section === undefined) return { ok: false, error: 'edit needs text or section' };
        set = { ...(text ? { text } : {}), ...(section !== undefined ? { section } : {}) };
      } else if (action === 'delete') set = { deleted: true };
      else set = { done: action === 'done' };
      break;
    }
    default:
      return { ok: false, error: `unknown action ${String(req.action)}` };
  }

  const op: TodoOp = { type: 'todo', id: itemId, set, ts: Date.now(), by: `agent:${agentGroupId}` };
  const item = await withState(group.folder, (state) => {
    const changed = applyOp(state, op);
    return { result: visibleItems(state).find((i) => i.id === itemId), changed };
  });
  const inApp = await pushToApps(agentGroupId, op);
  return { ok: true, ...(item ? { item } : {}), inApp };
}

registerDeliveryAction(
  'todo_request',
  async (content, session) => {
    const requestId = content.requestId;
    if (typeof requestId !== 'string' || !requestId) {
      log.warn('todo_request missing requestId', { sessionId: session.id });
      return;
    }
    let answer: TodoAnswer;
    try {
      // The list is the calling session's group's, never one named in the request.
      // `action` is this action's own name; the list operation is todoAction.
      answer = await handleTodoRequest(session.agent_group_id, { ...content, action: content.todoAction });
    } catch (err) {
      answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `todo-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ type: 'todo_response', requestId, ...answer }),
      trigger: false,
    });
    log.info('Todo request answered', { sessionId: session.id, action: content.action, ok: answer.ok });
  },
  unguarded("the calling group's own todo list"),
);
