import { describe, it, expect, beforeEach, vi } from 'vitest';

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
