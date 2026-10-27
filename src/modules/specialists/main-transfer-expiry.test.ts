/**
 * Files a specialist delivered to the main agent are placed into its ipc-in,
 * which is cleared when the main container exits. They were expired at that
 * exit on the assumption the agent had read them. If the container exited
 * first — idle reap, restart — the message pointing at the files was read by
 * the next container, and the files were gone. Now the message decides (spec:
 * TransferExpiredOnRoutedMessage*, TransferResetOnMainRecipientExit): handled
 * means done, otherwise the transfer goes back to pending and is re-placed.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-main-transfer-expiry';

const mailbox = vi.hoisted(() => ({
  acked: [] as string[],
  pending: [] as string[],
  processing: [] as string[],
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-main-transfer-expiry' };
});
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  withExistingMailboxSession: vi.fn(async (_ag: string, _s: string, action: (m: unknown) => unknown) =>
    action({
      getTerminalProcessingAcks: () => mailbox.acked.map((messageId) => ({ messageId, status: 'completed' })),
      getMessageForRetry: (id: string, status: 'pending' | 'processing') =>
        (status === 'pending' ? mailbox.pending : mailbox.processing).includes(id) ? { id } : undefined,
    }),
  ),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { createSpecialist, createTask } from './db.js';
import { buildInvocationForSession, endInvocationById, TRANSFERS_BASE_DIR } from './invocation.js';

const now = () => new Date().toISOString();

/** The main agent's session, a running invocation in it, and a delivered root task. */
async function mainWithInvocation(): Promise<string> {
  for (const id of ['ag-main', 'ag-spec']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  await createSpecialist({
    agent_group_id: 'ag-spec',
    is_memory_provider: 0,
    last_turn_sub_notice: null,
    last_turn_parent_notice: null,
    created_at: now(),
  });
  const session = {
    id: 'sess-main',
    agent_group_id: 'ag-main',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  } as const;
  await createSession(session);
  await createTask({
    id: 'task-root',
    specialist_group_id: 'ag-spec',
    prompt: 'p',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'completed',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: now(),
    result: 'see report',
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  });
  const built = await buildInvocationForSession(session as unknown as Session);
  return built!.invocationId;
}

/** The root task's files, placed into the running main container's ipc-in (or still waiting to be). */
async function placed(invocationId: string, routedMessageId: string | null, waiting = false): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id, routed_message_id)
     VALUES ('xfer', 'task-root', ?, 'see report', 0, 1, ?, ?, 'sess-main', ?)`,
    invocationId,
    now(),
    waiting ? 'pending' : 'in_transit',
    routedMessageId,
  );
  await db.run(
    `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
     VALUES ('tf', 'xfer', 'report.md', '/x/report.md', ?, NULL)`,
    waiting ? 'owned' : 'placed',
  );
  fs.mkdirSync(path.join(TRANSFERS_BASE_DIR, 'xfer'), { recursive: true });
}

async function state(): Promise<{ transfer: string; file: string; staged: boolean }> {
  const db = getDb();
  const t = (await db.get("SELECT status FROM container_transfers WHERE id = 'xfer'")) as { status: string };
  const f = (await db.get("SELECT status FROM transfer_files WHERE id = 'tf'")) as { status: string };
  return { transfer: t.status, file: f.status, staged: fs.existsSync(path.join(TRANSFERS_BASE_DIR, 'xfer')) };
}

const DONE = { transfer: 'expired', file: 'expired', staged: false };
const OWED = { transfer: 'pending', file: 'owned', staged: true };

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  mailbox.acked = [];
  mailbox.pending = [];
  mailbox.processing = [];
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('main agent exits holding delivered files', () => {
  it('expires them once the message carrying them was handled', async () => {
    const inv = await mainWithInvocation();
    await placed(inv, 'msg-result');
    mailbox.acked = ['msg-result'];

    await endInvocationById(inv);

    expect(await state()).toEqual(DONE);
  });

  it('keeps them for the next container when it exited before reaching the message', async () => {
    const inv = await mainWithInvocation();
    await placed(inv, 'msg-result');
    mailbox.pending = ['msg-result'];

    await endInvocationById(inv);

    expect(await state()).toEqual(OWED);
  });

  it("trusts the container's ack over a host status not yet synced", async () => {
    const inv = await mainWithInvocation();
    await placed(inv, 'msg-result');
    mailbox.processing = ['msg-result'];
    mailbox.acked = ['msg-result'];

    await endInvocationById(inv);

    expect(await state()).toEqual(DONE);
  });

  it('expires them when the message failed and will never be read', async () => {
    const inv = await mainWithInvocation();
    await placed(inv, 'msg-result'); // neither pending, processing nor acked

    await endInvocationById(inv);

    expect(await state()).toEqual(DONE);
  });

  it('expires a transfer recorded before its message was', async () => {
    const inv = await mainWithInvocation();
    await placed(inv, null);
    mailbox.pending = ['msg-other'];

    await endInvocationById(inv);

    expect(await state()).toEqual(DONE);
  });

  // A transfer can still be pending when its message is handled (its files
  // never reached this container's ipc-in). It was then placed into the next
  // container's ipc-in for nothing; it is done with, like a placed one.
  it('expires a transfer still waiting to be placed once its message was handled', async () => {
    const inv = await mainWithInvocation();
    await placed(inv, 'msg-result', true);
    mailbox.acked = ['msg-result'];

    await endInvocationById(inv);

    expect(await state()).toEqual(DONE);
  });

  it('leaves a waiting transfer whose message is still to be read', async () => {
    const inv = await mainWithInvocation();
    await placed(inv, 'msg-result', true);
    mailbox.pending = ['msg-result'];

    await endInvocationById(inv);

    expect(await state()).toEqual(OWED);
  });
});
