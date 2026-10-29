/**
 * Propagated from specs/memory-graph.allium — research dispatch and the
 * report a researcher hands back: ResearchDispatched, ReportAndNoteCreated,
 * and the ZettelkastenWork surface.
 *
 * The host side runs for real — handleDispatchSpecialist,
 * handleDeliverSpecialistResult and result routing against a migrated test
 * DB and a temporary GROUPS_DIR / DATA_DIR. Only the process and container
 * boundaries are faked: container wake and liveness, the session mailbox
 * writes (captured, so routed messages can be read), request-wake, boot-crash
 * state and the null channel's presence.
 *
 * What the main agent does with a result (writes the note, links it, tells
 * the user) is carried by its untracked standing instructions; those claims
 * are `unimplemented` (see ./tracked.ts).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  root: '/tmp/nanoclaw-test-graph-spec-research',
  writes: [] as Array<{ sessionId: string; text: string; trigger: boolean }>,
  woken: [] as string[],
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `${h.root}/data`,
  GROUPS_DIR: `${h.root}/groups`,
}));
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn(async (s: { id: string }) => {
    h.woken.push(s.id);
    return true;
  }),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn(() => false),
}));
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  initSessionFolder: vi.fn(),
  writeSessionMessage: vi.fn(
    async (_ag: string, sessionId: string, msg: { content: string; trigger?: boolean | number }) => {
      h.writes.push({ sessionId, text: JSON.parse(msg.content).text, trigger: Boolean(msg.trigger) });
    },
  ),
  withExistingMailboxSession: vi.fn(async () => undefined),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../channels/null-channel.js', () => ({
  NULL_CHANNEL_TYPE: 'null_channel',
  NULL_CHANNEL_PLATFORM_ID: 'specialist',
  getNullMessagingGroupId: async () => 'mg-null',
}));
vi.mock('../../modules/boot-crash/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/boot-crash/index.js')>()),
  getBootCrashState: vi.fn(() => ({ count: 0, stderrTail: [] })),
  clearBootCrashState: vi.fn(),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createSpecialist, createTask, getTask } from '../../modules/specialists/db.js';
import { handleDeliverSpecialistResult } from '../../modules/specialists/delivery.js';
import { handleDispatchSpecialist } from '../../modules/specialists/dispatch.js';
import { buildInvocationForSession } from '../../modules/specialists/invocation.js';
import type { SpecialistTask } from '../../modules/specialists/types.js';
import type { Session } from '../../types.js';
import { divergence, obligation, unimplemented } from './harness.js';
import { expectTrackedInstruction } from './tracked.js';

const GROUPS = `${h.root}/groups`;
const RESEARCHER_FOLDER = 'specialists-researcher'; // config.researcher_folder
const now = () => new Date().toISOString();

// ── world ────────────────────────────────────────────────────────────────────

async function group(id: string, folder: string, kind: 'plain' | 'specialist'): Promise<void> {
  await createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: now() });
  if (kind === 'specialist')
    await createSpecialist({
      agent_group_id: id,
      is_memory_provider: 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: now(),
    });
}

async function session(id: string, agentGroupId: string, threadId: string | null): Promise<Session> {
  await createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    processing_state: 'idle',
    last_active: now(),
    created_at: now(),
  });
  return (await getSession(id))!;
}

function taskRow(over: Partial<SpecialistTask> & Pick<SpecialistTask, 'id'>): SpecialistTask {
  return {
    specialist_group_id: 'ag-rsrch',
    prompt: 'Investigate: aardvarks',
    requester_group_id: 'ag-main',
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
    ...over,
  };
}

/** A running task with its own session, and an invocation whose ipc-out holds `files`. */
async function runningTask(over: Partial<SpecialistTask> & Pick<SpecialistTask, 'id'>, files: Record<string, string>) {
  const t = taskRow(over);
  await createTask(t);
  const s = await session(`sess-${t.id}`, t.specialist_group_id, t.id);
  const built = await buildInvocationForSession(s);
  const inv = (await getDb().get('SELECT ipc_out_host_path FROM invocations WHERE id = ?', built!.invocationId)) as {
    ipc_out_host_path: string;
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(inv.ipc_out_host_path, name), text);
  return s;
}

const allTasks = () => getDb().all<SpecialistTask>('SELECT * FROM specialist_tasks');
const told = (sessionId: string) => h.writes.filter((w) => w.sessionId === sessionId).map((w) => w.text);
const reportsOf = (folder: string) => {
  const dir = path.join(GROUPS, folder, 'zettel', 'reports');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

async function created(fn: () => Promise<void>): Promise<SpecialistTask[]> {
  const before = new Set((await allTasks()).map((t) => t.id));
  await fn();
  return (await allTasks()).filter((t) => !before.has(t.id));
}

beforeEach(async () => {
  fs.rmSync(h.root, { recursive: true, force: true });
  h.writes.length = 0;
  h.woken.length = 0;
  await runMigrations(await initTestDb());
  await createMessagingGroup({
    id: 'mg-null',
    channel_type: 'null_channel',
    platform_id: 'specialist',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await group('ag-main', 'main', 'plain');
  await getDb().run('UPDATE agent_groups SET is_main = 1 WHERE id = ?', 'ag-main');
  await group('ag-rsrch', RESEARCHER_FOLDER, 'specialist');
  await group('ag-coder', 'specialists-coder', 'specialist');
  await session('sess-main', 'ag-main', null);
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(h.root, { recursive: true, force: true });
});

// ── ResearchDispatched ───────────────────────────────────────────────────────

describe('ResearchDispatched', () => {
  obligation('rule-success.ResearchDispatched', async () => {
    const main = (await getSession('sess-main'))!;
    const made = await created(() =>
      handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt: 'Investigate: aardvarks' }, main),
    );

    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ specialist_group_id: 'ag-rsrch', status: 'queued' });
    // The researcher's task session is woken with the prompt as its trigger.
    const s = await getDb().get<Session>('SELECT * FROM sessions WHERE thread_id = ?', made[0].id);
    expect(s).toMatchObject({ agent_group_id: 'ag-rsrch', messaging_group_id: 'mg-null' });
    expect(h.writes.filter((w) => w.sessionId === s!.id)).toEqual([
      expect.objectContaining({ text: 'Investigate: aardvarks', trigger: true }),
    ]);
    expect(h.woken).toEqual([s!.id]);
  });

  obligation('rule-failure.ResearchDispatched.1', async () => {
    // No researcher group in this install.
    await getDb().run("DELETE FROM specialists WHERE agent_group_id = 'ag-rsrch'");
    await getDb().run("DELETE FROM agent_groups WHERE id = 'ag-rsrch'");
    const main = (await getSession('sess-main'))!;
    const made = await created(() =>
      handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt: 'Investigate: aardvarks' }, main),
    );
    expect(made).toEqual([]);
    expect(h.woken).toEqual([]);
    expect(told('sess-main').join('\n')).toContain('dispatch_specialist failed: agent group "ag-rsrch" not found');
  });

  obligation('rule-failure.ResearchDispatched.2', async () => {
    // The researcher folder exists, but its group is not a specialist.
    await getDb().run("DELETE FROM specialists WHERE agent_group_id = 'ag-rsrch'");
    const main = (await getSession('sess-main'))!;
    const made = await created(() =>
      handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt: 'Investigate: aardvarks' }, main),
    );
    expect(made).toEqual([]);
    expect(h.woken).toEqual([]);
    expect(told('sess-main').join('\n')).toContain('is not a specialist');
  });

  obligation('rule-entity-creation.ResearchDispatched.1', async () => {
    // research_prompt(subject) is written by the main agent (its untracked
    // instructions); the host keeps the prompt it is given, verbatim.
    const main = (await getSession('sess-main'))!;
    const prompt = 'Investigate: https://example.com/aardvarks\n\nSummarise faithfully what the source says.';
    const t0 = now();
    const [t] = await created(() => handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt }, main));
    const t1 = now();

    expect(t).toMatchObject({
      specialist_group_id: 'ag-rsrch',
      prompt,
      requester_group_id: 'ag-main',
      requester_task_id: null,
      requester_session_id: 'sess-main', // main_session_for_group: the session that asked
      depth: 0,
      chain_delegation_count: 1,
      is_last_same_type_dispatch: 0,
      status: 'queued',
      restart_attempt_count: 0,
      closed_at: null,
    });
    expect(JSON.parse(t.ancestor_group_ids)).toEqual([]);
    expect(t.dispatched_at >= t0 && t.dispatched_at <= t1).toBe(true);
  });
});

// ── ReportAndNoteCreated ─────────────────────────────────────────────────────
//
// The host's half: a completed researcher root task with committed files has
// them in the main group's zettel/reports/, recorded in committed_files and
// named in the routed message ([Committed to your memory: …]) — that marker is
// what the main agent's instructions write a note from. Each requires clause
// falsified below leaves the marker (and so the note) out.

describe('ReportAndNoteCreated', () => {
  unimplemented(
    'rule-success.ReportAndNoteCreated',
    'writing the note from the committed report is only in the untracked groups/dm-with-alanz/instructions.prepend.md (host half: specialists results.test.ts SpecialistResultRoutedToMain)',
    () =>
      expectTrackedInstruction(
        'follow the A-MEM Note-Taking steps below to create a linked note from the report content',
      ),
  );

  unimplemented(
    'rule-failure.ReportAndNoteCreated.1',
    'nothing limits note-writing to researcher results: the host commits and names files for any specialist; only the untracked instructions scope it to the research workflow',
    () => expectTrackedInstruction('**3. On result return**'),
  );

  obligation('rule-failure.ReportAndNoteCreated.2', async () => {
    // requester_group = null: a researcher sub-task (asked by the coder). Its
    // report goes to the parent, never into the main group's zettel/reports/.
    await createTask(taskRow({ id: 'task-coder', specialist_group_id: 'ag-coder', status: 'awaiting_sub_task' }));
    await session('sess-task-coder', 'ag-coder', 'task-coder');
    const child = await runningTask(
      {
        id: 'task-rsrch',
        requester_group_id: null,
        requester_task_id: 'task-coder',
        requester_session_id: 'sess-task-coder',
        depth: 1,
        chain_delegation_count: 2,
        ancestor_group_ids: '["ag-coder"]',
      },
      { '2026-10-29-aardvarks.md': '# Aardvarks' },
    );
    await getDb().run("UPDATE specialist_tasks SET pending_sub_task_id = 'task-rsrch' WHERE id = 'task-coder'");

    await handleDeliverSpecialistResult(
      { result_text: '2026-10-29-aardvarks.md', file_paths: ['2026-10-29-aardvarks.md'], commit_to_memory: true },
      child,
    );

    const t = (await getTask('task-rsrch'))!;
    expect(t.status).toBe('completed');
    expect(t.committed_files).toBeNull();
    expect(reportsOf('main')).toEqual([]);
    expect(told('sess-main')).toEqual([]);
    expect(told('sess-task-coder').join('\n')).not.toContain('[Committed to your memory');
  });

  obligation('rule-failure.ReportAndNoteCreated.3', async () => {
    // committed_files = null: the researcher handed files back without commit_to_memory.
    const s = await runningTask({ id: 'task-rsrch' }, { '2026-10-29-aardvarks.md': '# Aardvarks' });

    await handleDeliverSpecialistResult(
      { result_text: '2026-10-29-aardvarks.md', file_paths: ['2026-10-29-aardvarks.md'] },
      s,
    );

    const t = (await getTask('task-rsrch'))!;
    expect(t.status).toBe('completed');
    expect(t.committed_files).toBeNull();
    expect(reportsOf('main')).toEqual([]);
    const [msg] = told('sess-main');
    expect(msg).toBeDefined();
    expect(msg).not.toContain('[Committed to your memory');
  });

  obligation('rule-failure.ReportAndNoteCreated.4', async () => {
    // committed_files empty: commit_to_memory with no file to commit (text only).
    const s = await runningTask({ id: 'task-rsrch' }, {});

    await handleDeliverSpecialistResult({ result_text: 'Aardvarks eat termites.', commit_to_memory: true }, s);

    const t = (await getTask('task-rsrch'))!;
    expect(t.status).toBe('completed');
    expect(t.committed_files ? JSON.parse(t.committed_files) : []).toEqual([]);
    expect(reportsOf('main')).toEqual([]);
    expect(told('sess-main')).toEqual(['Aardvarks eat termites.']);
  });

  unimplemented(
    'rule-entity-creation.ReportAndNoteCreated.1',
    "the note's id, links, sources and empty supersedes are only in the untracked groups/dm-with-alanz/instructions.prepend.md",
    () => expectTrackedInstruction('3. Write note to `zettel/notes/MEM-YYYY-MM-DD-{slug}.md` with `links:` populated'),
  );
});

// ── ZettelkastenWork ─────────────────────────────────────────────────────────

describe('ZettelkastenWork', () => {
  obligation('surface-actor.ZettelkastenWork', async () => {
    // Faces the main agent's session: a research request from it is taken;
    // the same request from a specialist's task session is not.
    const main = (await getSession('sess-main'))!;
    const fromMain = await created(() =>
      handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt: 'Investigate: aardvarks' }, main),
    );
    expect(fromMain).toHaveLength(1);

    await createTask(taskRow({ id: 'task-coder', specialist_group_id: 'ag-coder' }));
    const coder = await session('sess-task-coder', 'ag-coder', 'task-coder');
    const fromCoder = await created(() =>
      handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt: 'Investigate: aardvarks' }, coder),
    );
    expect(fromCoder).toEqual([]);
    expect(told('sess-task-coder').join('\n')).toContain('dispatch_specialist failed');
  });

  divergence(
    'surface-provides.ZettelkastenWork',
    'the spec offers MainAgentResearchRequest to any session whose group has specialist = null; dispatch_specialist only takes it from the is_main group',
    async () => {
      // A second ordinary (non-specialist) group, not the main one.
      await group('ag-cli', 'cli-with-alan', 'plain');
      const cli = await session('sess-cli', 'ag-cli', null);
      const made = await created(() =>
        handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt: 'Investigate: aardvarks' }, cli),
      );
      expect(told('sess-cli')).toEqual([]);
      expect(made).toHaveLength(1);
    },
  );
});
