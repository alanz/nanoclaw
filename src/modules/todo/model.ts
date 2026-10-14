/**
 * The todo list as merged state: a last-writer-wins register per item field.
 *
 * Every change is an op — `{type:'todo', id, set:{…fields}, ts, by}` — carried
 * as a WebXDC status update, so the list lives in the app's update log and
 * every device (and the host) rebuilds it from that log. A field takes the
 * value with the greatest (ts, by) stamp, so the result does not depend on
 * the order ops arrive in; deletion is a field too (a tombstone), so a late
 * edit cannot bring a deleted item back. A snapshot carries whole items with
 * their stamps and merges the same way — that is how a freshly sent app
 * starts with the current list.
 *
 * The app (src/channels/deltachat-webxdc-todo/index.html) holds the same
 * merge between its `todo-model` markers; a test runs both on the same ops.
 */

export interface Stamped<T> {
  v: T;
  ts: number;
  by: string;
}

export interface TodoItem {
  id: string;
  created: number;
  text: Stamped<string>;
  section: Stamped<string>;
  done: Stamped<boolean>;
  deleted: Stamped<boolean>;
}

export interface TodoFields {
  text?: string;
  section?: string;
  done?: boolean;
  deleted?: boolean;
}

export interface TodoOp {
  type: 'todo';
  id: string;
  set: TodoFields;
  ts: number;
  by: string;
}

export interface TodoSnapshot {
  type: 'todo_snapshot';
  items: TodoItem[];
}

export type TodoState = Record<string, TodoItem>;

export const MAX_TEXT = 500;
export const MAX_SECTION = 60;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Is stamp a newer than stamp b? Ties on ts break on the writer, so every device agrees. */
function newer(a: { ts: number; by: string }, b: { ts: number; by: string }): boolean {
  return a.ts > b.ts || (a.ts === b.ts && a.by > b.by);
}

function blank(id: string, created: number): TodoItem {
  const none = { ts: 0, by: '' };
  return {
    id,
    created,
    text: { v: '', ...none },
    section: { v: '', ...none },
    done: { v: false, ...none },
    deleted: { v: false, ...none },
  };
}

/** The op in a payload, or null when it is not a well-formed todo op. */
export function parseOp(p: unknown): TodoOp | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (o.type !== 'todo' || typeof o.id !== 'string' || !ID_RE.test(o.id)) return null;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || typeof o.by !== 'string' || o.by.length > 100) return null;
  const s = o.set as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return null;
  const set: TodoFields = {};
  if (typeof s.text === 'string') set.text = s.text.slice(0, MAX_TEXT);
  if (typeof s.section === 'string') set.section = s.section.slice(0, MAX_SECTION);
  if (typeof s.done === 'boolean') set.done = s.done;
  if (typeof s.deleted === 'boolean') set.deleted = s.deleted;
  if (Object.keys(set).length === 0) return null;
  return { type: 'todo', id: o.id, set, ts: o.ts, by: o.by };
}

/** Merge one op into the state. Returns true when anything changed. */
export function applyOp(state: TodoState, op: TodoOp): boolean {
  const item = state[op.id] ?? (state[op.id] = blank(op.id, op.ts));
  let changed = false;
  if (op.ts < item.created) {
    item.created = op.ts;
    changed = true;
  }
  for (const key of ['text', 'section', 'done', 'deleted'] as const) {
    const v = op.set[key];
    if (v === undefined) continue;
    const field = item[key] as Stamped<unknown>;
    if (newer(op, field)) {
      (item[key] as Stamped<unknown>) = { v, ts: op.ts, by: op.by };
      changed = true;
    }
  }
  return changed;
}

/** Merge a snapshot's items, field by field. Returns true when anything changed. */
export function applySnapshot(state: TodoState, items: unknown): boolean {
  if (!Array.isArray(items)) return false;
  let changed = false;
  for (const raw of items) {
    const it = raw as Partial<TodoItem> | null;
    if (!it || typeof it.id !== 'string' || !ID_RE.test(it.id) || typeof it.created !== 'number') continue;
    for (const key of ['text', 'section', 'done', 'deleted'] as const) {
      const f = it[key] as Stamped<unknown> | undefined;
      if (!f || typeof f.ts !== 'number' || typeof f.by !== 'string' || f.ts === 0) continue;
      const ok = key === 'text' || key === 'section' ? typeof f.v === 'string' : typeof f.v === 'boolean';
      if (!ok) continue;
      if (applyOp(state, { type: 'todo', id: it.id, set: { [key]: f.v } as TodoFields, ts: f.ts, by: f.by })) {
        changed = true;
      }
    }
    const item = state[it.id];
    if (item && it.created < item.created) {
      item.created = it.created;
      changed = true;
    }
  }
  return changed;
}

/** Merge whatever a status-update payload carries. Returns true when anything changed. */
export function applyPayload(state: TodoState, payload: unknown): boolean {
  const op = parseOp(payload);
  if (op) return applyOp(state, op);
  const p = payload as { type?: unknown; items?: unknown } | null;
  if (p?.type === 'todo_snapshot') return applySnapshot(state, p.items);
  return false;
}

export interface VisibleItem {
  id: string;
  text: string;
  section: string;
  done: boolean;
  created: number;
}

/** The live items: not deleted, with text; by section (unsectioned first), then age. */
export function visibleItems(state: TodoState): VisibleItem[] {
  return Object.values(state)
    .filter((i) => !i.deleted.v && i.text.v.trim())
    .map((i) => ({ id: i.id, text: i.text.v, section: i.section.v, done: i.done.v, created: i.created }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.created - b.created || a.id.localeCompare(b.id));
}

/** The list as Markdown, for the agent to read. */
export function renderMarkdown(state: TodoState, updatedAt: string): string {
  const items = visibleItems(state);
  const out = [
    '---',
    'type: todo-list',
    `description: Alan's todo list, mirrored from the NanoClaw Todo app (updated ${updatedAt})`,
    '---',
    '',
    '# Todo',
    '',
    'Change it with the `todo` tool, not by editing this file (the app is the source; this is a copy).',
    '',
  ];
  let section: string | null = null;
  for (const it of items) {
    if (it.section !== section) {
      section = it.section;
      if (section) out.push('', `## ${section}`, '');
    }
    out.push(`- [${it.done ? 'x' : ' '}] ${it.text} <!-- id:${it.id} -->`);
  }
  if (items.length === 0) out.push('_The list is empty._');
  return out.join('\n') + '\n';
}

/** A new item id: short, URL-safe, unique enough for one person's list. */
export function newItemId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
