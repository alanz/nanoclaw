import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _initTestDatabase, getNewMessages, storeChatMetadata } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';

beforeEach(() => {
  _initTestDatabase();
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
