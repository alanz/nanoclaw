/**
 * Session reset + summaries (specs/session-reset.allium), against a real
 * central DB and real session folders. Only "is a container running" and the
 * delivery adapter are faked; the clock is passed in.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-session-reset';

const fakes = vi.hoisted(() => ({
  running: new Set<string>(),
  delivered: [] as string[],
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-session-reset/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-session-reset/groups',
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  isContainerRunning: (id: string) => fakes.running.has(id),
}));

vi.mock('../../delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../delivery.js')>()),
  getDeliveryAdapter: () => ({
    deliver: async (_c: string, _p: string, _t: string | null, _k: string, text: string) => {
      fakes.delivered.push(text);
      return null;
    },
  }),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSession, updateSession } from '../../db/sessions.js';
import { openOutboundDbRw } from '../../mailbox/sqlite/session-db.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder, withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import type { SessionResetConfig } from './config.js';
import { getActiveConversation, getConversation, getPendingReset } from './db.js';
import {
  archiveEndedConversations,
  dailyResetCheck,
  freshConversationEnv,
  observeSession,
  summarySweep,
} from './engine.js';
import { claudeTranscriptDir } from './transcript.js';

const AG = 'ag-reset';
const FOLDER = 'dm';
const GROUP_DIR = path.join(TEST_ROOT, 'groups', FOLDER);

const CONFIG: SessionResetConfig = {
  groups: new Set([FOLDER]),
  resetTime: '04:00',
  minIdleMs: 60 * 60_000,
  maxSummaryAttempts: 3,
  sessionsIndexEntries: 7,
};

let session: Session;

function at(iso: string): Date {
  return new Date(iso);
}

/** Stand in for the container: store (or clear) the conversation id in outbound.db. */
function setConversation(id: string | null): void {
  const db = openOutboundDbRw(outboundDbPath(AG, session.id));
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS session_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
    );
    if (id) {
      db.prepare(
        `INSERT INTO session_state (key, value, updated_at) VALUES ('continuation:claude', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(id, new Date().toISOString());
    } else {
      db.prepare("DELETE FROM session_state WHERE key = 'continuation:claude'").run();
    }
  } finally {
    db.close();
  }
}

function writeTranscript(id: string, turns: Array<[string, string]>): string {
  const dir = claudeTranscriptDir(AG);
  fs.mkdirSync(dir, { recursive: true });
  const lines = turns.flatMap(([user, assistant]) => [
    JSON.stringify({ type: 'user', message: { content: user } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: assistant }] } }),
  ]);
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

async function setLastActive(iso: string): Promise<void> {
  await updateSession(session.id, { last_active: iso });
  session = (await getSession(session.id))!;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUP_DIR, { recursive: true });
  fakes.running.clear();
  fakes.delivered.length = 0;

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Andy',
    folder: FOLDER,
    agent_provider: null,
    created_at: '2026-01-01T00:00:00Z',
  });
  await ensureContainerConfig(AG);
  await updateContainerConfigScalars(AG, { timezone: 'UTC' });
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'deltachat',
    platform_id: 'dc:10',
    name: 'DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-01-01T00:00:00Z',
  });
  session = {
    id: 'sess-chat',
    agent_group_id: AG,
    messaging_group_id: 'mg-dm',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: '2026-10-05T20:00:00.000Z',
    created_at: '2026-01-01T00:00:00Z',
  };
  await createSession(session);
  initSessionFolder(AG, session.id);
});

afterEach(async () => {
  await closeDb();
});

describe('observing conversations', () => {
  it('starts a conversation for a new id, and ends it as cleared when the id goes', async () => {
    setConversation('conv-1');
    await observeSession(session, at('2026-10-05T20:00:00Z'));
    expect((await getActiveConversation(session.id))?.conversation_id).toBe('conv-1');

    setConversation(null);
    await observeSession(session, at('2026-10-05T20:01:00Z'));
    const ended = await getConversation(session.id, 'conv-1');
    expect(ended).toMatchObject({ status: 'ended', end_reason: 'cleared' });
    expect(await getActiveConversation(session.id)).toBeUndefined();
  });

  it('ends the previous conversation as rotated when its transcript was moved aside', async () => {
    setConversation('conv-1');
    await observeSession(session, at('2026-10-05T20:00:00Z'));
    const file = writeTranscript('conv-1', [['hi', 'hello']]);
    fs.renameSync(file, `${file}.rotated-1790000000000`);

    setConversation('conv-2');
    await observeSession(session, at('2026-10-05T20:01:00Z'));
    expect(await getConversation(session.id, 'conv-1')).toMatchObject({ status: 'ended', end_reason: 'rotated' });
    expect((await getActiveConversation(session.id))?.conversation_id).toBe('conv-2');
  });
});

describe('daily reset', () => {
  beforeEach(async () => {
    setConversation('conv-1');
    writeTranscript('conv-1', [['What is on today?', 'Two meetings and a review.']]);
    await observeSession(session, at('2026-10-05T20:00:00Z'));
    // The first daily check only starts the count: never a reset on deploy,
    // even past the reset time with the chat two hours quiet.
    await dailyResetCheck(session, CONFIG, at('2026-10-05T22:00:00Z'));
    expect(await getPendingReset(session.id)).toBeUndefined();
  });

  it('ends a quiet conversation at the reset time and asks the next start for a fresh one', async () => {
    await dailyResetCheck(session, CONFIG, at('2026-10-06T03:59:00Z'));
    expect(await getPendingReset(session.id)).toBeUndefined();

    await dailyResetCheck(session, CONFIG, at('2026-10-06T04:00:00Z'));
    expect(await getConversation(session.id, 'conv-1')).toMatchObject({ status: 'ended', end_reason: 'reset' });
    expect(await freshConversationEnv(session)).toEqual({ NANOCLAW_FRESH_CONVERSATION: '1' });

    // The runner drops the old id on that start: the reset has taken effect.
    setConversation(null);
    expect(await freshConversationEnv(session)).toBeUndefined();
    expect(await getPendingReset(session.id)).toBeUndefined();

    // The new conversation is seen as a new one, not as a cleared old one.
    setConversation('conv-2');
    await observeSession(session, at('2026-10-06T08:00:00Z'));
    expect(await getConversation(session.id, 'conv-1')).toMatchObject({ end_reason: 'reset' });
    expect((await getActiveConversation(session.id))?.conversation_id).toBe('conv-2');
  });

  it('keeps asking for a fresh start until the old conversation is actually gone', async () => {
    await dailyResetCheck(session, CONFIG, at('2026-10-06T04:00:00Z'));
    // A start that failed before the runner cleared the id: ask again.
    expect(await freshConversationEnv(session)).toEqual({ NANOCLAW_FRESH_CONVERSATION: '1' });
    expect(await freshConversationEnv(session)).toEqual({ NANOCLAW_FRESH_CONVERSATION: '1' });
    // An observation tick between starts must not end it a second time.
    await observeSession(session, at('2026-10-06T04:01:00Z'));
    expect(await getPendingReset(session.id)).toBeDefined();
  });

  it('skips the day when the chat was active within the idle window', async () => {
    await setLastActive('2026-10-06T03:30:00.000Z');
    await dailyResetCheck(session, CONFIG, at('2026-10-06T04:00:00Z'));
    expect(await getPendingReset(session.id)).toBeUndefined();

    // Quiet by 06:00, but the day's decision was already made.
    await dailyResetCheck(session, CONFIG, at('2026-10-06T06:00:00Z'));
    expect(await getPendingReset(session.id)).toBeUndefined();
    expect((await getActiveConversation(session.id))?.conversation_id).toBe('conv-1');
  });

  it('counts an agent reply as activity, not only inbound messages', async () => {
    const db = openOutboundDbRw(outboundDbPath(AG, session.id));
    db.prepare(
      "INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('m1', 1, '2026-10-06T03:45:00.000Z', 'chat', '{}')",
    ).run();
    db.close();
    await dailyResetCheck(session, CONFIG, at('2026-10-06T04:00:00Z'));
    expect(await getPendingReset(session.id)).toBeUndefined();
  });

  it('skips the day when the container is running', async () => {
    fakes.running.add(session.id);
    await dailyResetCheck(session, CONFIG, at('2026-10-06T04:00:00Z'));
    expect(await getPendingReset(session.id)).toBeUndefined();
  });

  it('does nothing when there has been no conversation since the last reset', async () => {
    await dailyResetCheck(session, CONFIG, at('2026-10-06T04:00:00Z'));
    setConversation(null);
    await freshConversationEnv(session);
    await dailyResetCheck(session, CONFIG, at('2026-10-07T04:00:00Z'));
    expect(await getPendingReset(session.id)).toBeUndefined();
  });
});

describe('archive and summary', () => {
  async function endConversationOne(): Promise<void> {
    setConversation('conv-1');
    writeTranscript('conv-1', [
      ['Plan the week', 'Monday: review. Tuesday: write.'],
      ['Add a dentist visit', 'Added Thursday 10:00.'],
    ]);
    await observeSession(session, at('2026-10-05T20:00:00Z'));
    setConversation(null);
    await observeSession(session, at('2026-10-05T21:30:00Z'));
    await archiveEndedConversations(at('2026-10-05T21:30:00Z'));
  }

  it('archives the ended conversation and names where its summary will go', async () => {
    await endConversationOne();
    const row = await getConversation(session.id, 'conv-1');
    expect(row?.archive_path).toBe('conversations/2026-10-05-2130-cleared.md');
    expect(row?.summary_target).toBe('memory/sessions/2026-10-05-2130.md');
    const archive = fs.readFileSync(path.join(GROUP_DIR, row!.archive_path!), 'utf-8');
    expect(archive).toContain('conversation_id: conv-1');
    expect(archive).toContain('**User**: Add a dentist visit');
    expect(archive).toContain('**Andy**: Added Thursday 10:00.');
  });

  it('writes a placeholder archive and no summary when the transcript is gone', async () => {
    setConversation('conv-x');
    await observeSession(session, at('2026-10-05T20:00:00Z'));
    setConversation(null);
    await observeSession(session, at('2026-10-05T21:30:00Z'));
    await archiveEndedConversations(at('2026-10-05T21:30:00Z'));
    expect(await getConversation(session.id, 'conv-x')).toMatchObject({
      archive_path: 'conversations/2026-10-05-2130-cleared-missing.md',
      summary_status: 'failed',
    });
  });

  it('schedules a summary task, and settles done once the file exists', async () => {
    await endConversationOne();
    await summarySweep(CONFIG, at('2026-10-05T21:31:00Z'));
    let row = (await getConversation(session.id, 'conv-1'))!;
    expect(row).toMatchObject({ summary_status: 'scheduled', summary_attempts: 1 });
    const task = await withExistingMailboxSession(AG, row.summary_task_session_id!, (mb) =>
      mb.getTask(row.summary_task_id!),
    );
    expect(task?.status).toBe('pending');
    expect(JSON.parse(task!.content).prompt).toContain(`/workspace/agent/${row.archive_path}`);

    // Still running: nothing changes.
    await summarySweep(CONFIG, at('2026-10-05T21:32:00Z'));
    expect((await getConversation(session.id, 'conv-1'))!.summary_attempts).toBe(1);

    fs.writeFileSync(path.join(GROUP_DIR, row.summary_target!), '---\ntype: session-summary\n---\n');
    await updateSession(row.summary_task_session_id!, { status: 'closed' });
    await summarySweep(CONFIG, at('2026-10-05T21:40:00Z'));
    row = (await getConversation(session.id, 'conv-1'))!;
    expect(row).toMatchObject({ summary_status: 'done', summary_path: 'memory/sessions/2026-10-05-2130.md' });
  });

  it('retries a summary that did not appear, then leaves a failed placeholder and says so once', async () => {
    await endConversationOne();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await summarySweep(CONFIG, at(`2026-10-05T22:0${attempt}:00Z`));
      const row = (await getConversation(session.id, 'conv-1'))!;
      expect(row.summary_attempts).toBe(attempt);
      await updateSession(row.summary_task_session_id!, { status: 'closed' });
    }
    await summarySweep(CONFIG, at('2026-10-05T22:10:00Z'));
    const row = (await getConversation(session.id, 'conv-1'))!;
    expect(row).toMatchObject({
      summary_status: 'failed',
      summary_attempts: 3,
      summary_path: 'memory/sessions/2026-10-05-2130-failed.md',
    });
    expect(fs.readFileSync(path.join(GROUP_DIR, row.summary_path!), 'utf-8')).toContain(row.archive_path!);
    expect(fakes.delivered).toHaveLength(1);

    await summarySweep(CONFIG, at('2026-10-05T22:11:00Z'));
    expect(fakes.delivered).toHaveLength(1);
  });
});
