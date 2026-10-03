/**
 * Specialist task sessions carry the null channel's messaging group. The
 * invocation code recognised them by "no messaging group", so with a real
 * session it never did (P1, seen live): task_id was never recorded, and a
 * container that ended while its task was still live had its in-transit files
 * expired rather than kept for the next container. Since specialists exit on
 * dispatch_sub_task, a parent holding one child's files that delegates again
 * lost them. The other tests build sessions with no messaging group, which is
 * why they never showed it.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-invocation-identity';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-invocation-identity' };
});

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { createSpecialist, createTask } from './db.js';
import {
  buildInvocationForSession,
  endInvocationById,
  sweepTransferStaging,
  TRANSFERS_BASE_DIR,
} from './invocation.js';
import type { SpecialistTask } from './types.js';

const now = () => new Date().toISOString();

function task(
  id: string,
  group: string,
  status: SpecialistTask['status'],
  requesterTask: string | null,
): SpecialistTask {
  return {
    id,
    specialist_group_id: group,
    prompt: 'p',
    requester_group_id: requesterTask ? null : 'ag-main',
    requester_task_id: requesterTask,
    requester_session_id: 'sess-main',
    depth: requesterTask ? 1 : 0,
    chain_delegation_count: 0,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status,
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
  };
}

/** A parent specialist task in `status`, with a session shaped like a real one. */
async function parentSession(status: SpecialistTask['status']): Promise<Session> {
  for (const id of ['ag-main', 'ag-parent', 'ag-child']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  for (const id of ['ag-parent', 'ag-child']) {
    await createSpecialist({
      agent_group_id: id,
      is_memory_provider: 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: now(),
    });
  }
  // The null channel's messaging group: what createSpecialistSession attaches.
  await createMessagingGroup({
    id: 'mg-null',
    channel_type: 'null',
    platform_id: 'null',
    name: 'null',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const base = {
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    processing_state: 'idle' as const,
    last_active: now(),
    created_at: now(),
  };
  await createSession({
    ...base,
    id: 'sess-main',
    agent_group_id: 'ag-main',
    messaging_group_id: 'mg-null',
    thread_id: null,
  });
  await createTask(task('task-parent', 'ag-parent', status, null));
  await createTask(task('task-child', 'ag-child', 'completed', 'task-parent'));
  const session = {
    ...base,
    id: 'sess-parent',
    agent_group_id: 'ag-parent',
    messaging_group_id: 'mg-null',
    thread_id: 'task-parent',
  };
  await createSession(session);
  return session as unknown as Session;
}

/** The child's result, placed in the parent's current ipc-in (in transit). */
async function inTransitTo(sessionId: string, senderInvocationId: string): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
     VALUES ('xfer-1', 'task-child', ?, 'findings', 0, 1, ?, 'in_transit', ?)`,
    senderInvocationId,
    now(),
    sessionId,
  );
  await db.run(
    `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status, memory_path)
     VALUES ('tf-1', 'xfer-1', 'report.md', '/tmp/x/report.md', 'placed', NULL)`,
  );
}

async function transferState(): Promise<{ transfer: string; file: string }> {
  const db = getDb();
  const t = (await db.get("SELECT status FROM container_transfers WHERE id = 'xfer-1'")) as { status: string };
  const f = (await db.get("SELECT status FROM transfer_files WHERE id = 'tf-1'")) as { status: string };
  return { transfer: t.status, file: f.status };
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('specialist session identity in invocations', () => {
  it('records the task an invocation runs for', async () => {
    const session = await parentSession('running');

    const built = await buildInvocationForSession(session);

    const row = (await getDb().get('SELECT task_id FROM invocations WHERE id = ?', built!.invocationId)) as {
      task_id: string | null;
    };
    expect(row.task_id).toBe('task-parent');
  });

  it("keeps a live task's in-transit files for its next container", async () => {
    const session = await parentSession('awaiting_sub_task'); // exited to delegate again
    const built = await buildInvocationForSession(session);
    await inTransitTo(session.id, built!.invocationId);

    await endInvocationById(built!.invocationId);

    expect(await transferState()).toEqual({ transfer: 'pending', file: 'owned' });
  });

  it("expires a finished task's in-transit files", async () => {
    const session = await parentSession('completed');
    const built = await buildInvocationForSession(session);
    await inTransitTo(session.id, built!.invocationId);

    await endInvocationById(built!.invocationId);

    expect(await transferState()).toEqual({ transfer: 'expired', file: 'expired' });
  });
});

// P12: a transfer's staging copies were never reclaimed (only when every file
// in a delivery failed to copy), so data/v2-transfers grew with each delivery.
// They are needed while the transfer can still be placed, and not after.
describe('transfer staging', () => {
  const staging = (id: string) => path.join(TRANSFERS_BASE_DIR, id);
  function stage(id: string): void {
    fs.mkdirSync(staging(id), { recursive: true });
    fs.writeFileSync(path.join(staging(id), 'report.md'), 'x');
  }

  it("is reclaimed when a finished task's in-transit transfer expires", async () => {
    const session = await parentSession('completed');
    const built = await buildInvocationForSession(session);
    await inTransitTo(session.id, built!.invocationId);
    stage('xfer-1');

    await endInvocationById(built!.invocationId);

    expect(fs.existsSync(staging('xfer-1'))).toBe(false);
  });

  it("is kept when a live task's transfer goes back to pending", async () => {
    const session = await parentSession('awaiting_sub_task');
    const built = await buildInvocationForSession(session);
    await inTransitTo(session.id, built!.invocationId);
    stage('xfer-1');

    await endInvocationById(built!.invocationId);

    expect(fs.existsSync(staging('xfer-1'))).toBe(true);
  });

  it('is swept at host start for expired and unknown transfers, kept for live ones', async () => {
    const session = await parentSession('awaiting_sub_task');
    const built = await buildInvocationForSession(session);
    await inTransitTo(session.id, built!.invocationId); // xfer-1: in_transit
    const db = getDb();
    for (const [id, status] of [
      ['xfer-pending', 'pending'],
      ['xfer-expired', 'expired'],
    ]) {
      await db.run(
        `INSERT INTO container_transfers (id, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status, recipient_session_id)
         VALUES (?, 'task-child', ?, 'r', 0, 0, ?, ?, NULL)`,
        id,
        built!.invocationId,
        new Date().toISOString(),
        status,
      );
    }
    for (const id of ['xfer-1', 'xfer-pending', 'xfer-expired', 'xfer-unknown']) stage(id);

    expect(await sweepTransferStaging()).toBe(2);

    expect(fs.existsSync(staging('xfer-1'))).toBe(true);
    expect(fs.existsSync(staging('xfer-pending'))).toBe(true);
    expect(fs.existsSync(staging('xfer-expired'))).toBe(false);
    expect(fs.existsSync(staging('xfer-unknown'))).toBe(false);
  });
});
