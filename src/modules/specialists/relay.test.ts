/**
 * Specialist messages to the user (specs/null-channel.allium
 * SpecialistProgressRelayed, SpecialistCardRelayed, SpecialistAnswerCopied,
 * NullChannelOutputDiscarded; specialists.allium root_requester_session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  delivered: [] as Array<{
    channelType: string;
    platformId: string;
    threadId: string | null;
    kind: string;
    content: Record<string, unknown>;
  }>,
  written: [] as Array<{ sessionId: string; message: { id: string; content: string; trigger?: boolean } }>,
  destinations: new Map<string, unknown[]>(),
  contributor: null as null | ((ctx: { session: unknown }) => Promise<unknown>),
}));

vi.mock('../../channels/null-channel.js', () => ({
  NULL_CHANNEL_TYPE: 'null_channel',
  NULL_CHANNEL_PLATFORM_ID: 'specialist',
  getNullMessagingGroupId: async () => 'mg-null',
}));
vi.mock('../../container-runner.js', () => ({
  registerSessionContributor: (fn: typeof fakes.contributor) => {
    fakes.contributor = fn;
  },
}));
vi.mock('../../delivery.js', () => ({
  registerPostDeliveryHook: () => {},
  getDeliveryAdapter: () => ({
    deliver: async (
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
    ) => {
      fakes.delivered.push({ channelType, platformId, threadId, kind, content: JSON.parse(content) });
      return 'dc-msg-1';
    },
  }),
}));
vi.mock('../../response-registry.js', () => ({ registerResponseHandler: () => {} }));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: async (
    _ag: string,
    sessionId: string,
    message: { id: string; content: string; trigger?: boolean },
  ) => {
    fakes.written.push({ sessionId, message });
  },
  withMailboxSession: async (
    _ag: string,
    sessionId: string,
    fn: (m: { replaceDestinations: (d: unknown[]) => void }) => unknown,
  ) => fn({ replaceDestinations: (d) => fakes.destinations.set(sessionId, d) }),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createPendingQuestion, createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { createSpecialist, createTask } from './db.js';
import { copySpecialistAnswer, relaySpecialistMessage, rootRequesterSession } from './relay.js';
import type { SpecialistTask } from './types.js';

const NOW = new Date().toISOString();

function session(id: string, agentGroupId: string, mg: string | null, thread: string | null): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: mg,
    thread_id: thread,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    processing_state: 'idle',
    last_active: NOW,
    created_at: NOW,
  } as Session;
}

function task(id: string, group: string, requester: { session: string; task?: string }): SpecialistTask {
  return {
    id,
    specialist_group_id: group,
    prompt: id,
    requester_group_id: requester.task ? null : 'ag-main',
    requester_task_id: requester.task ?? null,
    requester_session_id: requester.session,
    depth: requester.task ? 1 : 0,
    chain_delegation_count: 0,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    dispatched_at: NOW,
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };
}

const outbound = (kind: string, content: Record<string, unknown>, channelType = 'null_channel') =>
  ({
    id: 'out-1',
    kind,
    platformId: 'specialist',
    channelType,
    threadId: 't-rev',
    content: JSON.stringify(content),
  }) as never;

let researcher: Session;
let reviewer: Session;
let main: Session;

beforeEach(async () => {
  fakes.delivered.length = 0;
  fakes.written.length = 0;
  fakes.destinations.clear();
  const db = await initTestDb();
  await runMigrations(db);
  for (const [id, name] of [
    ['ag-main', 'Andy'],
    ['ag-rsrch', 'Researcher'],
    ['ag-revwr', 'Reviewer'],
  ]) {
    await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: NOW });
  }
  for (const id of ['ag-rsrch', 'ag-revwr']) {
    await createSpecialist({
      agent_group_id: id,
      is_memory_provider: 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: NOW,
    });
  }
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'deltachat',
    platform_id: 'dc:42',
    instance: null,
    name: 'DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  } as never);
  await createMessagingGroup({
    id: 'mg-null',
    channel_type: 'null_channel',
    platform_id: 'specialist',
    instance: null,
    name: 'null',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  } as never);

  main = session('sess-main', 'ag-main', 'mg-dm', null);
  researcher = session('sess-rsrch', 'ag-rsrch', 'mg-null', 't-rsrch');
  reviewer = session('sess-revwr', 'ag-revwr', 'mg-null', 't-rev');
  for (const s of [main, researcher, reviewer]) await createSession(s);
  await createTask(task('t-rsrch', 'ag-rsrch', { session: 'sess-main' }));
  await createTask(task('t-rev', 'ag-revwr', { session: 'sess-rsrch', task: 't-rsrch' }));
});

afterEach(async () => {
  await closeDb();
});

describe('rootRequesterSession', () => {
  it('follows requester_task links to the session that dispatched the root task', async () => {
    const { getTask } = await import('./db.js');
    expect((await rootRequesterSession((await getTask('t-rev'))!))?.id).toBe('sess-main');
    expect((await rootRequesterSession((await getTask('t-rsrch'))!))?.id).toBe('sess-main');
  });
});

describe('the requester destination', () => {
  it('a specialist session gets exactly `requester`, aimed at its own null-channel chat', async () => {
    await fakes.contributor!({ session: reviewer });
    expect(fakes.destinations.get('sess-revwr')).toEqual([
      expect.objectContaining({
        name: 'requester',
        type: 'channel',
        channelType: 'null_channel',
        platformId: 'specialist',
      }),
    ]);
  });

  it('other sessions are left alone', async () => {
    await fakes.contributor!({ session: main });
    expect(fakes.destinations.has('sess-main')).toBe(false);
  });
});

describe('relaySpecialistMessage', () => {
  it("relays a sub-task's progress to the root requester's chat as the specialist, with a non-waking copy", async () => {
    await relaySpecialistMessage(outbound('chat', { text: 'Halfway through the review' }), reviewer);
    expect(fakes.delivered).toEqual([
      {
        channelType: 'deltachat',
        platformId: 'dc:42',
        threadId: null,
        kind: 'chat',
        content: { text: 'Halfway through the review', sender: 'Reviewer' },
      },
    ]);
    expect(fakes.written).toHaveLength(1);
    expect(fakes.written[0].sessionId).toBe('sess-main');
    expect(fakes.written[0].message.trigger).toBe(false);
    expect(JSON.parse(fakes.written[0].message.content).text).toBe(
      '[Reviewer told the user: Halfway through the review]',
    );
  });

  it('relays a question card with the sender and copies what was asked', async () => {
    await relaySpecialistMessage(
      outbound('chat-sdk', {
        type: 'ask_question',
        questionId: 'q1',
        title: 'Scope',
        question: 'Include tests?',
        options: ['Yes', 'No'],
      }),
      researcher,
    );
    expect(fakes.delivered[0]).toMatchObject({
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'q1', sender: 'Researcher' },
    });
    expect(JSON.parse(fakes.written[0].message.content).text).toBe(
      '[Researcher asked the user: Scope — Include tests? (options: Yes / No)]',
    );
  });

  it('prefixes the name on channels without per-message senders', async () => {
    await getDbRun("UPDATE messaging_groups SET channel_type = 'cli' WHERE id = 'mg-dm'");
    await relaySpecialistMessage(outbound('chat', { text: 'hi' }), researcher);
    expect(fakes.delivered[0].content.text).toBe('[Researcher] hi');
  });

  it('does not relay failure notices, edits, other channels or non-specialist sessions', async () => {
    await relaySpecialistMessage(outbound('chat', { text: 'x', failureNotice: true }), researcher);
    await relaySpecialistMessage(outbound('chat', { operation: 'edit', messageId: '1', text: 'x' }), researcher);
    await relaySpecialistMessage(outbound('chat', { text: 'x' }, 'deltachat'), main);
    await relaySpecialistMessage(outbound('chat', { text: 'x' }), main);
    expect(fakes.delivered).toEqual([]);
    expect(fakes.written).toEqual([]);
  });

  it('drops the message when the root requester has no chat', async () => {
    await getDbRun("UPDATE sessions SET messaging_group_id = NULL WHERE id = 'sess-main'");
    await relaySpecialistMessage(outbound('chat', { text: 'x' }), researcher);
    expect(fakes.delivered).toEqual([]);
  });
});

describe('copySpecialistAnswer', () => {
  it("copies the user's answer to a specialist's question to the main agent, without claiming it", async () => {
    await createPendingQuestion({
      question_id: 'q1',
      session_id: 'sess-rsrch',
      message_out_id: 'out-1',
      platform_id: 'specialist',
      channel_type: 'null_channel',
      thread_id: 't-rsrch',
      title: 'Scope',
      options: [{ label: 'Include tests', selectedLabel: 'Include tests', value: 'yes' }],
      created_at: NOW,
    });
    const claimed = await copySpecialistAnswer({ questionId: 'q1', value: 'yes', userId: 'dc:fp:A' } as never);
    expect(claimed).toBe(false);
    expect(fakes.written[0].sessionId).toBe('sess-main');
    expect(JSON.parse(fakes.written[0].message.content).text).toBe(
      '[Researcher asked "Scope"; the user chose: Include tests]',
    );
  });

  it("ignores the main agent's own questions", async () => {
    await createPendingQuestion({
      question_id: 'q2',
      session_id: 'sess-main',
      message_out_id: 'out-2',
      platform_id: 'dc:42',
      channel_type: 'deltachat',
      thread_id: null,
      title: 'T',
      options: [],
      created_at: NOW,
    });
    expect(await copySpecialistAnswer({ questionId: 'q2', value: 'x', userId: 'u' } as never)).toBe(false);
    expect(fakes.written).toEqual([]);
  });
});

async function getDbRun(sql: string): Promise<void> {
  const { getDb } = await import('../../db/connection.js');
  await getDb().run(sql);
}
