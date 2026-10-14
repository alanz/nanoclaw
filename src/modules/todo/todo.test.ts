/**
 * The todo list: the merge (order-independent, tombstones that stick) and the
 * module around it — the agent's tool, the readable copy, ops to and from the
 * app — against a real central DB and group folder.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-todo';
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-test-todo/groups',
}));

const written = vi.hoisted(() => [] as Array<{ id: string; content: string }>);
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  writeSessionMessage: async (_ag: string, _s: string, m: { id: string; content: string }) => {
    written.push(m);
  },
}));

import { getDeliveryAction } from '../../delivery.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { handleTodoRequest, registerTodoTransport, todoSnapshotFor, todoUpdatesFromApp } from './index.js';
import { type TodoOp, type TodoState, applyOp, applyPayload, parseOp, visibleItems } from './model.js';

const op = (id: string, set: TodoOp['set'], ts: number, by = 'me'): TodoOp => ({ type: 'todo', id, set, ts, by });

describe('the merge', () => {
  it('gives the same list whatever order the ops arrive in', () => {
    const ops = [
      op('a', { text: 'milk', done: false }, 1),
      op('a', { done: true }, 3, 'phone'),
      op('a', { text: 'oat milk' }, 2, 'laptop'),
      op('b', { text: 'bread', section: 'Shop' }, 4),
      op('a', { done: false }, 3, 'agent'), // same ts as the phone's: the writer breaks the tie
    ];
    const run = (order: TodoOp[]) => {
      const s: TodoState = {};
      for (const o of order) applyOp(s, o);
      return visibleItems(s);
    };
    const forward = run(ops);
    expect(run([...ops].reverse())).toEqual(forward);
    expect(run([ops[2], ops[4], ops[0], ops[3], ops[1]])).toEqual(forward);
    expect(forward.find((i) => i.id === 'a')).toMatchObject({ text: 'oat milk', done: true });
  });

  it('keeps a deleted item deleted when an older edit arrives late', () => {
    const s: TodoState = {};
    applyOp(s, op('a', { text: 'milk' }, 1));
    applyOp(s, op('a', { deleted: true }, 5));
    applyOp(s, op('a', { text: 'milk!' }, 3));
    expect(visibleItems(s)).toEqual([]);
  });

  it('merges a snapshot field by field, newest wins', () => {
    const s: TodoState = {};
    applyOp(s, op('a', { text: 'milk', done: false }, 10));
    const other: TodoState = {};
    applyOp(other, op('a', { text: 'old', done: true }, 5));
    applyOp(other, op('c', { text: 'eggs' }, 6));
    expect(applyPayload(s, { type: 'todo_snapshot', items: Object.values(other) })).toBe(true);
    expect(visibleItems(s).map((i) => [i.id, i.text, i.done])).toEqual([
      ['a', 'milk', false],
      ['c', 'eggs', false],
    ]);
    expect(applyPayload(s, { type: 'todo_snapshot', items: Object.values(other) })).toBe(false);
  });

  it('rejects malformed ops', () => {
    expect(parseOp({ type: 'todo', id: 'bad id!', set: { text: 'x' }, ts: 1, by: 'me' })).toBeNull();
    expect(parseOp({ type: 'todo', id: 'a', set: {}, ts: 1, by: 'me' })).toBeNull();
    expect(parseOp({ type: 'todo', id: 'a', set: { text: 'x' }, ts: 'soon', by: 'me' })).toBeNull();
    expect(parseOp({ type: 'message', id: 'a' })).toBeNull();
    expect(parseOp({ type: 'todo', id: 'a', set: { text: 'x'.repeat(900) }, ts: 1, by: 'me' })?.set.text).toHaveLength(
      500,
    );
  });
});

describe('the todo module', () => {
  const AG = 'ag-todo';
  const FOLDER = 'dm';
  const listFile = path.join(ROOT, 'groups', FOLDER, 'todo', 'list.md');
  let pushed: Array<{ platformId: string; payloads: unknown[] }>;
  let appOpen: boolean;

  beforeEach(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, 'groups', FOLDER), { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: AG,
      name: 'Andy',
      folder: FOLDER,
      agent_provider: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'deltachat',
      platform_id: 'dc:10',
      name: 'DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: '2026-01-01T00:00:00Z',
    });
    await createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-dm',
      agent_group_id: AG,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: '2026-01-01T00:00:00Z',
    } as Parameters<typeof createMessagingGroupAgent>[0]);
    pushed = [];
    appOpen = true;
    registerTodoTransport('deltachat', {
      async push(platformId, payloads) {
        pushed.push({ platformId, payloads });
        return appOpen;
      },
    });
  });

  afterEach(async () => {
    await closeDb();
  });

  it("adds, ticks and deletes through the agent's tool, writing the readable copy and pushing to the app", async () => {
    const added = await handleTodoRequest(AG, { action: 'add', text: 'Renew passport', section: 'Admin' });
    expect(added).toMatchObject({
      ok: true,
      inApp: true,
      item: { text: 'Renew passport', section: 'Admin', done: false },
    });
    const id = added.item!.id;
    expect(pushed[0]).toMatchObject({
      platformId: 'dc:10',
      payloads: [{ type: 'todo', id, set: { text: 'Renew passport' } }],
    });
    expect(fs.readFileSync(listFile, 'utf-8')).toContain(`## Admin\n\n- [ ] Renew passport <!-- id:${id} -->`);

    expect(await handleTodoRequest(AG, { action: 'done', id })).toMatchObject({ ok: true, item: { done: true } });
    expect(fs.readFileSync(listFile, 'utf-8')).toContain('- [x] Renew passport');

    expect((await handleTodoRequest(AG, { action: 'list' })).items).toHaveLength(1);
    expect(await handleTodoRequest(AG, { action: 'delete', id })).toMatchObject({ ok: true });
    expect((await handleTodoRequest(AG, { action: 'list' })).items).toEqual([]);
  });

  it('answers the container tool through the registered action (the list operation is todoAction)', async () => {
    written.length = 0;
    const action = getDeliveryAction('todo_request')!;
    const session = { id: 'sess-1', agent_group_id: AG } as Parameters<typeof action>[1];
    await action({ action: 'todo_request', requestId: 'r1', todoAction: 'add', text: 'Call the bank' }, session);
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('todo-resp-r1');
    expect(JSON.parse(written[0].content)).toMatchObject({
      type: 'todo_response',
      requestId: 'r1',
      ok: true,
      item: { text: 'Call the bank' },
    });
  });

  it('says when no list app is open: the change waits in the list for the next /todo', async () => {
    appOpen = false;
    expect(await handleTodoRequest(AG, { action: 'add', text: 'Call Dana' })).toMatchObject({ ok: true, inApp: false });
    const snap = await todoSnapshotFor('deltachat', 'dc:10');
    expect(snap.items.map((i) => i.text.v)).toEqual(['Call Dana']);
  });

  it('refuses unknown items and bad requests', async () => {
    expect(await handleTodoRequest(AG, { action: 'done', id: 'nope' })).toMatchObject({ ok: false });
    expect(await handleTodoRequest(AG, { action: 'add' })).toMatchObject({ ok: false });
    expect(await handleTodoRequest(AG, { action: 'frobnicate' })).toMatchObject({ ok: false });
  });

  it("merges the app's ops into the wired group's list", async () => {
    await todoUpdatesFromApp('deltachat', 'dc:10', [
      { type: 'todo', id: 'p1', set: { text: 'Buy milk', done: false }, ts: 100, by: 'phone' },
      { type: 'todo', id: 'p1', set: { done: true }, ts: 200, by: 'phone' },
      { type: 'meta', msgId: 9 },
    ]);
    expect((await handleTodoRequest(AG, { action: 'list' })).items).toEqual([
      expect.objectContaining({ id: 'p1', text: 'Buy milk', done: true }),
    ]);
    await todoUpdatesFromApp('deltachat', 'dc:999', [
      { type: 'todo', id: 'q', set: { text: 'stray' }, ts: 1, by: 'x' },
    ]);
    expect((await handleTodoRequest(AG, { action: 'list' })).items).toHaveLength(1);
  });
});
