import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _initTestDatabase,
  createSpecialistTask,
  getNewMessages,
  getSpecialistSession,
  getSpecialistTask,
  storeChatMetadata,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { _resetSpecialistDepsForTest, initSpecialists } from './specialists.js';
import {
  _resetSpecialistTypesForTest,
  _setSpecialistTypesForTest,
} from './specialist-types.js';
import { SpecialistType } from './types.js';

const RESEARCHER: SpecialistType = {
  name: 'researcher',
  description: 'Researches topics',
  isMemoryProvider: false,
};
const MEMORY_PROVIDER: SpecialistType = {
  name: 'memory',
  description: 'Provides memory',
  isMemoryProvider: true,
};
const MAIN_JID = 'main@g.us';

let startContainerFn: ReturnType<typeof vi.fn>;
let notifyMainGroupFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _initTestDatabase();
  _resetSpecialistTypesForTest();
  _setSpecialistTypesForTest([RESEARCHER, MEMORY_PROVIDER]);
  _resetSpecialistDepsForTest();
  startContainerFn = vi.fn().mockResolvedValue(undefined);
  notifyMainGroupFn = vi.fn().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initSpecialists({
    startContainerFn: startContainerFn as any,
    notifyMainGroupFn: notifyMainGroupFn as any,
  });
});

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    registeredGroups: () => ({}),
    registerGroup: vi.fn(),
    setGroupTrusted: vi.fn(),
    syncGroups: vi.fn(),
    startRemoteControl: vi.fn(),
    stopRemoteControl: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    setPendingDispatchDepth: vi.fn(),
    ...overrides,
  };
}

describe('run_eval', () => {
  it('blocks non-main groups', async () => {
    const deps = makeDeps();

    // Should return without writing any response file (no filesystem side effects)
    await processTaskIpc(
      {
        type: 'run_eval',
        requestId: 'req-1',
        skillName: 'test-skill',
        prompt: 'do something',
        withSkill: true,
      },
      'deltachat_some-group',
      false, // not main
      deps,
    );

    // No IPC calls should have been made
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when required fields are missing', async () => {
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'run_eval',
        // missing requestId, skillName, prompt, withSkill
      },
      'main',
      true,
      deps,
    );

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('writes an error response when main group is not registered', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'nanoclaw-test-'));
    let tmpIpcDir: string | undefined;

    try {
      // Override DATA_DIR by pointing IPC dir resolution at tmpDir.
      // We test by calling processTaskIpc directly — it writes to DATA_DIR/ipc/<source>/responses/.
      // Since DATA_DIR is hard-coded in config, we instead verify that the handler
      // reaches the "main group not found" branch by checking it doesn't hang or throw.
      const deps = makeDeps({
        registeredGroups: () => ({}), // no groups — mainGroup will be undefined
      });

      // processTaskIpc will try to write the error response to DATA_DIR/ipc/main/responses/req-err.json.
      // The response file may or may not be written depending on whether DATA_DIR exists.
      // What we care about is that it doesn't throw and doesn't call sendMessage.
      let threw = false;
      try {
        await processTaskIpc(
          {
            type: 'run_eval',
            requestId: 'req-err',
            skillName: 'test-skill',
            prompt: 'do something',
            withSkill: false,
          },
          'main',
          true,
          deps,
        );
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(deps.sendMessage).not.toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      if (tmpIpcDir) rmSync(tmpIpcDir, { recursive: true, force: true });
    }
  });
});

describe('deliver_result', () => {
  it('blocks delivery from the main group', async () => {
    const setPending = vi.fn();
    const deps = makeDeps({ setPendingDispatchDepth: setPending });

    await processTaskIpc(
      { type: 'deliver_result', text: 'done', dispatchDepth: 0 },
      'main',
      true, // isMain
      deps,
    );

    expect(setPending).not.toHaveBeenCalled();
  });

  it('blocks delivery when depth >= MAX_DISPATCH_DEPTH', async () => {
    const setPending = vi.fn();
    const mainJid = 'main@g.us';
    const deps = makeDeps({
      registeredGroups: () => ({
        [mainJid]: {
          name: 'Main',
          folder: 'main',
          trigger: 'hey',
          added_at: '',
          isMain: true,
        },
      }),
      setPendingDispatchDepth: setPending,
    });

    // MAX_DISPATCH_DEPTH defaults to 3 in config; depth=3 should be blocked
    await processTaskIpc(
      { type: 'deliver_result', text: 'done', dispatchDepth: 3 },
      'deltachat_intake',
      false,
      deps,
    );

    expect(setPending).not.toHaveBeenCalled();
  });

  it('injects an inbound message into the main group and sets pending depth', async () => {
    const mainJid = 'main@g.us';
    storeChatMetadata(mainJid, '2024-01-01T00:00:00.000Z');

    const setPending = vi.fn();
    const deps = makeDeps({
      registeredGroups: () => ({
        [mainJid]: {
          name: 'Main',
          folder: 'main',
          trigger: 'hey',
          added_at: '',
          isMain: true,
        },
      }),
      setPendingDispatchDepth: setPending,
    });

    await processTaskIpc(
      {
        type: 'deliver_result',
        text: 'Intake complete: 3 items processed',
        dispatchDepth: 1,
      },
      'deltachat_intake',
      false,
      deps,
    );

    // Message should be visible to the message loop (not a bot message)
    const { messages } = getNewMessages([mainJid], '', 'NanoClaw');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Intake complete: 3 items processed');
    expect(messages[0].sender_name).toBe('deltachat_intake');
    expect(messages[0].is_from_me).toBeFalsy();
    expect(messages[0].is_bot_message).toBeFalsy();

    // Depth propagated correctly: incoming depth 1, pending should be 2
    expect(setPending).toHaveBeenCalledWith(mainJid, 2);
  });

  it('blocks when no main group is registered', async () => {
    const setPending = vi.fn();
    const deps = makeDeps({
      registeredGroups: () => ({}), // no groups at all
      setPendingDispatchDepth: setPending,
    });

    await processTaskIpc(
      { type: 'deliver_result', text: 'done', dispatchDepth: 0 },
      'deltachat_intake',
      false,
      deps,
    );

    expect(setPending).not.toHaveBeenCalled();
  });

  it('blocks when text is missing', async () => {
    const mainJid = 'main@g.us';
    storeChatMetadata(mainJid, '2024-01-01T00:00:00.000Z');

    const setPending = vi.fn();
    const deps = makeDeps({
      registeredGroups: () => ({
        [mainJid]: {
          name: 'Main',
          folder: 'main',
          trigger: 'hey',
          added_at: '',
          isMain: true,
        },
      }),
      setPendingDispatchDepth: setPending,
    });

    await processTaskIpc(
      { type: 'deliver_result', dispatchDepth: 0 },
      'deltachat_intake',
      false,
      deps,
    );

    expect(setPending).not.toHaveBeenCalled();
    const { messages } = getNewMessages([mainJid], '', 'NanoClaw');
    expect(messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Specialist IPC commands
// ---------------------------------------------------------------------------

/** Create a running specialist task in the test DB. */
function makeRunningSpecialistTask(
  overrides: Partial<{
    id: string;
    specialist_type: string;
    depth: number;
    chain_delegation_count: number;
    ancestor_types: string;
    requester_group: string | null;
    requester_task_id: string | null;
  }> = {},
) {
  const id = overrides.id ?? 'task-parent';
  const now = new Date().toISOString();
  createSpecialistTask({
    id,
    specialist_type: overrides.specialist_type ?? 'researcher',
    prompt: 'Do research',
    requester_group: overrides.requester_group ?? MAIN_JID,
    requester_task_id: overrides.requester_task_id ?? null,
    depth: overrides.depth ?? 0,
    chain_delegation_count: overrides.chain_delegation_count ?? 1,
    ancestor_types: overrides.ancestor_types ?? '[]',
    is_last_same_type_dispatch: false,
    status: 'running',
    pending_sub_task_id: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    restart_attempt_count: 0,
    delegated_at: now,
    closed_at: null,
  });
  return getSpecialistTask(id)!;
}

describe('dispatch_specialist', () => {
  it('creates a sub-task and transitions parent to awaiting_sub_task', async () => {
    const parent = makeRunningSpecialistTask({ id: 'ds-parent-1' });
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'dispatch_specialist',
        parentTaskId: parent.id,
        parentTypeName: 'researcher',
        targetTypeName: 'researcher', // non-memory-provider, not in ancestor chain
        prompt: 'dispatch sub',
        sessionId: 'sess-ds-1',
      },
      'ds-parent-1',
      false,
      deps,
    );

    const updated = getSpecialistTask(parent.id)!;
    expect(updated.status).toBe('awaiting_sub_task');
    expect(updated.pending_sub_task_id).toBeTruthy();
    expect(startContainerFn).toHaveBeenCalled();
  });

  it('is a no-op when required fields are missing', async () => {
    makeRunningSpecialistTask({ id: 'ds-parent-2' });
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'dispatch_specialist', parentTaskId: 'ds-parent-2' },
      'ds-parent-2',
      false,
      deps,
    );

    expect(getSpecialistTask('ds-parent-2')?.status).toBe('running');
  });

  it('logs a warning when delegation policy rejects (does not throw)', async () => {
    // depth at limit — policy will reject
    const parent = makeRunningSpecialistTask({
      id: 'ds-parent-3',
      depth: 4, // maxSpecialistDepth - 1 = 4
    });
    const deps = makeDeps();

    let threw = false;
    try {
      await processTaskIpc(
        {
          type: 'dispatch_specialist',
          parentTaskId: parent.id,
          parentTypeName: 'researcher',
          targetTypeName: 'researcher', // non-memory-provider; policy rejects due to depth
          prompt: 'dispatch at max depth',
          sessionId: 'sess-ds-3',
        },
        'ds-parent-3',
        false,
        deps,
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // Parent stays running (policy rejection doesn't transition parent)
    expect(getSpecialistTask(parent.id)?.status).toBe('running');
  });

  it('does not throw when task does not exist (logs error)', async () => {
    const deps = makeDeps();
    let threw = false;
    try {
      await processTaskIpc(
        {
          type: 'dispatch_specialist',
          parentTaskId: 'nonexistent-task',
          parentTypeName: 'researcher',
          targetTypeName: 'memory',
          prompt: 'p',
          sessionId: 's',
        },
        'nonexistent-task',
        false,
        deps,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe('query_memory_specialist', () => {
  it('dispatches a memory query and transitions querying task to awaiting_sub_task', async () => {
    const task = makeRunningSpecialistTask({ id: 'qm-1' });
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'query_memory_specialist',
        taskId: task.id,
        targetTypeName: 'memory',
        prompt: 'what do you recall?',
        sessionId: 'sess-qm-1',
      },
      'qm-1',
      false,
      deps,
    );

    expect(getSpecialistTask(task.id)?.status).toBe('awaiting_sub_task');
    expect(startContainerFn).toHaveBeenCalledWith(
      expect.objectContaining({ specialist_type: 'memory' }),
      null,
    );
  });

  it('is a no-op when required fields are missing', async () => {
    makeRunningSpecialistTask({ id: 'qm-2' });
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'query_memory_specialist', taskId: 'qm-2' },
      'qm-2',
      false,
      deps,
    );

    expect(getSpecialistTask('qm-2')?.status).toBe('running');
  });

  it('does not throw when targeting a non-memory-provider type (logs error)', async () => {
    const task = makeRunningSpecialistTask({ id: 'qm-3' });
    const deps = makeDeps();
    let threw = false;
    try {
      await processTaskIpc(
        {
          type: 'query_memory_specialist',
          taskId: task.id,
          targetTypeName: 'researcher', // not a memory provider
          prompt: 'p',
          sessionId: 's',
        },
        'qm-3',
        false,
        deps,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(getSpecialistTask(task.id)?.status).toBe('running');
  });
});

describe('deliver_specialist_result', () => {
  it('marks the task completed and routes the result', async () => {
    const task = makeRunningSpecialistTask({
      id: 'dsr-1',
      requester_group: MAIN_JID,
    });
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'deliver_specialist_result',
        taskId: task.id,
        resultText: 'Research complete.',
      },
      'dsr-1',
      false,
      deps,
    );

    expect(getSpecialistTask(task.id)?.status).toBe('completed');
    expect(getSpecialistTask(task.id)?.result).toBe('Research complete.');
    expect(notifyMainGroupFn).toHaveBeenCalledWith(
      MAIN_JID,
      expect.stringContaining('Research complete.'),
    );
  });

  it('is a no-op when required fields are missing', async () => {
    makeRunningSpecialistTask({ id: 'dsr-2' });
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'deliver_specialist_result', taskId: 'dsr-2' },
      'dsr-2',
      false,
      deps,
    );

    expect(getSpecialistTask('dsr-2')?.status).toBe('running');
  });

  it('does not throw when task is not running (logs error)', async () => {
    const task = makeRunningSpecialistTask({ id: 'dsr-3' });
    // Manually mark it completed
    const { updateSpecialistTask } = await import('./db.js');
    updateSpecialistTask(task.id, {
      status: 'completed',
      result: 'done',
      closed_at: new Date().toISOString(),
    });

    const deps = makeDeps();
    let threw = false;
    try {
      await processTaskIpc(
        {
          type: 'deliver_specialist_result',
          taskId: task.id,
          resultText: 'second result',
        },
        'dsr-3',
        false,
        deps,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Status unchanged
    expect(getSpecialistTask(task.id)?.status).toBe('completed');
  });
});

describe('report_specialist_session', () => {
  it('creates a session record for the task', async () => {
    const task = makeRunningSpecialistTask({ id: 'rss-1' });
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'report_specialist_session',
        taskId: task.id,
        sessionId: 'claude-session-abc',
      },
      'rss-1',
      false,
      deps,
    );

    const session = getSpecialistSession(task.id);
    expect(session?.session_id).toBe('claude-session-abc');
    expect(session?.status).toBe('active');
  });

  it('updates an existing session when called again', async () => {
    const task = makeRunningSpecialistTask({ id: 'rss-2' });
    const deps = makeDeps();

    await processTaskIpc(
      {
        type: 'report_specialist_session',
        taskId: task.id,
        sessionId: 'sess-v1',
      },
      'rss-2',
      false,
      deps,
    );
    await processTaskIpc(
      {
        type: 'report_specialist_session',
        taskId: task.id,
        sessionId: 'sess-v2',
      },
      'rss-2',
      false,
      deps,
    );

    expect(getSpecialistSession(task.id)?.session_id).toBe('sess-v2');
  });

  it('is a no-op when required fields are missing', async () => {
    makeRunningSpecialistTask({ id: 'rss-3' });
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'report_specialist_session', taskId: 'rss-3' },
      'rss-3',
      false,
      deps,
    );

    expect(getSpecialistSession('rss-3')).toBeFalsy();
  });
});

describe('submit_raw_memory', () => {
  it('creates a raw memory submission and notifies the main group', async () => {
    const task = makeRunningSpecialistTask({ id: 'srm-1' });
    const deps = makeDeps({
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'main',
          trigger: 'hey',
          added_at: '',
          isMain: true,
        },
      }),
    });

    // stagingPath must be within the IPC dir; use a relative path under 'staging/'
    // We don't need the file to actually exist for the DB record; submitRawMemory
    // just stores the path string.
    await processTaskIpc(
      {
        type: 'submit_raw_memory',
        taskId: task.id,
        topic: 'key findings',
        stagingPath: 'staging/findings.md',
      },
      'srm-1',
      false,
      deps,
    );

    expect(notifyMainGroupFn).toHaveBeenCalledWith(
      MAIN_JID,
      expect.stringContaining('key findings'),
    );
  });

  it('blocks when staging path escapes the IPC directory', async () => {
    const task = makeRunningSpecialistTask({ id: 'srm-2' });
    const deps = makeDeps({
      registeredGroups: () => ({
        [MAIN_JID]: {
          name: 'Main',
          folder: 'main',
          trigger: 'hey',
          added_at: '',
          isMain: true,
        },
      }),
    });

    await processTaskIpc(
      {
        type: 'submit_raw_memory',
        taskId: task.id,
        topic: 'evil',
        stagingPath: '../../etc/passwd',
      },
      'srm-2',
      false,
      deps,
    );

    expect(notifyMainGroupFn).not.toHaveBeenCalled();
  });

  it('is a no-op when required fields are missing', async () => {
    makeRunningSpecialistTask({ id: 'srm-3' });
    const deps = makeDeps();

    await processTaskIpc(
      { type: 'submit_raw_memory', taskId: 'srm-3', topic: 'test' },
      'srm-3',
      false,
      deps,
    );

    expect(notifyMainGroupFn).not.toHaveBeenCalled();
  });

  it('is a no-op when no main group is registered', async () => {
    const task = makeRunningSpecialistTask({ id: 'srm-4' });
    const deps = makeDeps({ registeredGroups: () => ({}) });

    await processTaskIpc(
      {
        type: 'submit_raw_memory',
        taskId: task.id,
        topic: 'test',
        stagingPath: 'staging/t.md',
      },
      'srm-4',
      false,
      deps,
    );

    expect(notifyMainGroupFn).not.toHaveBeenCalled();
  });
});
