/**
 * Tests for session-archiving IPC task handlers and helpers.
 * Covers: request_session_archive, spawn_throwaway_session, spawnThrowaway,
 * getSessionJsonlPath, and placeholder/archive writing helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './db.js';
import {
  processTaskIpc,
  IpcDeps,
  getSessionJsonlPath,
  spawnThrowaway,
} from './ipc.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { RegisteredGroup } from './types.js';

// Mock container-runner so spawnThrowaway doesn't spawn real containers
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeNanoclawMetadata: vi.fn(),
  writeRssFeedsSnapshot: vi.fn(),
}));

import { runContainerAgent } from './container-runner.js';
const mockRunContainerAgent = runContainerAgent as ReturnType<typeof vi.fn>;

// Unique suffix per test run to avoid collisions with real data
const TEST_SUFFIX = `test-arch-${Date.now()}`;

/** Create a test group folder name with the test suffix. */
function testFolder(name: string): string {
  return `${name}-${TEST_SUFFIX}`;
}

/** Absolute path to a test group directory. */
function groupDir(folder: string): string {
  return path.join(GROUPS_DIR, folder);
}

/** Directories created during this test run — cleaned up in afterEach. */
const createdDirs: string[] = [];

function ensureDir(...parts: string[]): string {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  // Track only top-level test directories for cleanup
  const topLevel = path.join(GROUPS_DIR, parts[1] ?? '');
  if (!createdDirs.includes(topLevel)) createdDirs.push(topLevel);
  return p;
}

beforeEach(() => {
  _initTestDatabase();
  mockRunContainerAgent.mockReset();
});

afterEach(() => {
  // Clean up group directories created during the test
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  // Clean up session JSONL directories created during tests
  const sessionsBase = path.join(DATA_DIR, 'sessions');
  try {
    for (const entry of fs.readdirSync(sessionsBase)) {
      if (entry.includes(TEST_SUFFIX)) {
        fs.rmSync(path.join(sessionsBase, entry), {
          recursive: true,
          force: true,
        });
      }
    }
  } catch {
    /* ignore */
  }
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
    setReaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: 'Test Group',
    folder,
    trigger: '@bot',
    added_at: new Date().toISOString(),
  };
}

/** Write a JSONL session transcript with N user+assistant pairs at the real DATA_DIR path. */
function writeJonl(
  folder: string,
  sessionId: string,
  messageCount = 2,
): string {
  const jonlPath = getSessionJsonlPath(folder, sessionId);
  fs.mkdirSync(path.dirname(jonlPath), { recursive: true });
  // Track sessions base dir for cleanup
  const sessionGroupDir = path.join(DATA_DIR, 'sessions', folder);
  if (!createdDirs.includes(sessionGroupDir)) createdDirs.push(sessionGroupDir);

  const lines: string[] = [];
  for (let i = 0; i < messageCount; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `User message ${i}` },
        session_id: sessionId,
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Assistant reply ${i}` }],
        },
        session_id: sessionId,
      }),
    );
  }
  fs.writeFileSync(jonlPath, lines.join('\n') + '\n');
  return jonlPath;
}

// ---------------------------------------------------------------------------
// getSessionJsonlPath
// ---------------------------------------------------------------------------

describe('getSessionJsonlPath', () => {
  it('constructs the correct host-side JSONL path', () => {
    const p = getSessionJsonlPath('my-group', 'sess-abc');
    expect(p).toContain(path.join('sessions', 'my-group'));
    expect(p).toContain('.claude');
    expect(p).toContain('-workspace-group');
    expect(p.endsWith('sess-abc.jsonl')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// spawn_throwaway_session IPC task
// ---------------------------------------------------------------------------

describe('spawn_throwaway_session IPC task', () => {
  it('ignores task with missing required fields', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      { type: 'spawn_throwaway_session', jid: 'g@test', sessionId: 'sess-1' },
      'my-group',
      false,
      deps,
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('ignores task when group not registered', async () => {
    const deps = makeDeps({ registeredGroups: () => ({}) });
    await processTaskIpc(
      {
        type: 'spawn_throwaway_session',
        jid: 'g@test',
        sessionId: 'sess-1',
        groupFolder: 'unknown-group',
      },
      'my-group',
      false,
      deps,
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('spawns throwaway for registered group and passes correct container input', async () => {
    const folder = testFolder('tw-spawn');
    const group = makeGroup(folder);

    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
    });

    await processTaskIpc(
      {
        type: 'spawn_throwaway_session',
        jid: 'g@test',
        sessionId: 'sess-1',
        groupFolder: folder,
        jsonlPath: `/path/to/sess-1.jsonl`,
      },
      folder,
      false,
      deps,
    );

    // Non-blocking: give the async throwaway a tick to start
    await new Promise((r) => setTimeout(r, 0));

    expect(mockRunContainerAgent).toHaveBeenCalledOnce();
    const [calledGroup, calledInput] = mockRunContainerAgent.mock.calls[0];
    expect(calledGroup.folder).toBe(folder);
    expect(calledInput.sessionId).toBeUndefined(); // fresh session
    expect(calledInput.isMain).toBe(false);
    expect(calledInput.prompt).toContain('sess-1');
    expect(calledInput.prompt).toContain('memory/sessions/');
  });
});

// ---------------------------------------------------------------------------
// request_session_archive IPC task
// ---------------------------------------------------------------------------

describe('request_session_archive IPC task', () => {
  it('ignores task with missing fields', async () => {
    const deps = makeDeps();
    await processTaskIpc(
      { type: 'request_session_archive', jid: 'g@test' },
      'my-group',
      false,
      deps,
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('ignores task when group not registered', async () => {
    const deps = makeDeps({ registeredGroups: () => ({}) });
    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-1',
        groupFolder: 'unknown',
      },
      'my-group',
      false,
      deps,
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('emits ⏳ reaction immediately regardless of JSONL state', async () => {
    const folder = testFolder('ra-reaction');
    const group = makeGroup(folder);
    // No JSONL — will take the "missing" path
    const setReaction = vi.fn().mockResolvedValue(undefined);

    ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
      setReaction,
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-rr',
        groupFolder: folder,
      },
      folder,
      false,
      deps,
    );

    expect(setReaction).toHaveBeenCalledWith('g@test', '⏳');
  });

  it('writes placeholder archive+summary and emits 💭 when JSONL is missing', async () => {
    const folder = testFolder('ra-missing');
    const group = makeGroup(folder);
    const setReaction = vi.fn().mockResolvedValue(undefined);

    ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
      setReaction,
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-missing',
        groupFolder: folder,
      },
      folder,
      false,
      deps,
    );

    expect(mockRunContainerAgent).not.toHaveBeenCalled();
    expect(setReaction).toHaveBeenCalledWith('g@test', '⏳');
    expect(setReaction).toHaveBeenCalledWith('g@test', '💭');

    const archiveFiles = fs.readdirSync(
      groupDir(path.join(folder, 'conversations')),
    );
    expect(archiveFiles.some((f) => f.includes('missing'))).toBe(true);
    const summaryFiles = fs.readdirSync(
      groupDir(path.join(folder, 'memory', 'sessions')),
    );
    expect(summaryFiles.some((f) => f.includes('missing'))).toBe(true);
  });

  it('writes placeholder archive+summary and emits 💭 for empty session', async () => {
    const folder = testFolder('ra-empty');
    const group = makeGroup(folder);
    const setReaction = vi.fn().mockResolvedValue(undefined);

    ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    // JSONL exists but has no parseable messages
    const jonlPath = getSessionJsonlPath(folder, 'sess-empty');
    fs.mkdirSync(path.dirname(jonlPath), { recursive: true });
    createdDirs.push(path.join(DATA_DIR, 'sessions', folder));
    fs.writeFileSync(jonlPath, '');

    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
      setReaction,
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-empty',
        groupFolder: folder,
      },
      folder,
      false,
      deps,
    );

    expect(mockRunContainerAgent).not.toHaveBeenCalled();
    expect(setReaction).toHaveBeenCalledWith('g@test', '💭');
    const summaryFiles = fs.readdirSync(
      groupDir(path.join(folder, 'memory', 'sessions')),
    );
    expect(summaryFiles.some((f) => f.includes('empty'))).toBe(true);
  });

  it('writes real archive and spawns throwaway for a real session', async () => {
    const folder = testFolder('ra-real');
    const group = makeGroup(folder);
    const setReaction = vi.fn().mockResolvedValue(undefined);

    ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeJonl(folder, 'sess-real', 3);

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
      setReaction,
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-real',
        groupFolder: folder,
      },
      folder,
      false,
      deps,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunContainerAgent).toHaveBeenCalledOnce();

    // Real archive written (not placeholder)
    const archiveFiles = fs.readdirSync(
      groupDir(path.join(folder, 'conversations')),
    );
    expect(archiveFiles.some((f) => f.endsWith('-reset.md'))).toBe(true);
    const archiveContent = fs.readFileSync(
      path.join(groupDir(path.join(folder, 'conversations')), archiveFiles[0]),
      'utf-8',
    );
    expect(archiveContent).toContain('session_id: sess-real');
    expect(archiveContent).toContain('is_placeholder: false');
  });
});

// ---------------------------------------------------------------------------
// spawnThrowaway
// ---------------------------------------------------------------------------

describe('spawnThrowaway', () => {
  it('uses a fresh container session (no sessionId)', async () => {
    const folder = testFolder('tw-fresh');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    const deps = makeDeps();
    await spawnThrowaway(group, 'g@test', 'sess-tw', '/some/path.jsonl', deps);

    expect(mockRunContainerAgent).toHaveBeenCalledOnce();
    const [, input] = mockRunContainerAgent.mock.calls[0];
    expect(input.sessionId).toBeUndefined();
    expect(input.isMain).toBe(false);
    expect(input.groupFolder).toBe(folder);
    expect(input.chatJid).toBe('g@test');
  });

  it('emits ✅ reaction when container succeeds and summary file is written', async () => {
    const setReaction = vi.fn().mockResolvedValue(undefined);
    const folder = testFolder('tw-success');
    const group = makeGroup(folder);
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        // Simulate container writing the summary file
        const match = input.prompt.match(/memory\/sessions\/([\d-]+\.md)/);
        if (match) {
          fs.writeFileSync(
            path.join(sessDir, match[1]),
            `---\nsession_id: sess-ok\ncreated_at: ${new Date().toISOString()}\nis_placeholder: false\n---\n\n# Summary\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

    const deps = makeDeps({ setReaction });
    await spawnThrowaway(group, 'g@test', 'sess-ok', '/path.jsonl', deps);

    expect(setReaction).toHaveBeenCalledWith('g@test', '✅');
  });

  it('writes failed placeholder and emits 💭 when container returns error', async () => {
    const setReaction = vi.fn().mockResolvedValue(undefined);
    const folder = testFolder('tw-fail');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'OOM',
    });

    const deps = makeDeps({ setReaction });
    await spawnThrowaway(group, 'g@test', 'sess-fail', '/path.jsonl', deps);

    expect(setReaction).toHaveBeenCalledWith('g@test', '💭');

    const sessDir = path.join(GROUPS_DIR, folder, 'memory', 'sessions');
    const sessionFiles = fs.readdirSync(sessDir);
    expect(sessionFiles.some((f) => f.includes('failed'))).toBe(true);

    // Failed placeholder must mark is_placeholder: true
    const placeholderContent = fs.readFileSync(
      path.join(sessDir, sessionFiles.find((f) => f.includes('failed'))!),
      'utf-8',
    );
    expect(placeholderContent).toContain('is_placeholder: true');
    expect(placeholderContent).toContain('sess-fail');
  });

  it('includes session_id and summary path in the prompt', async () => {
    const folder = testFolder('tw-prompt');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    const deps = makeDeps();
    await spawnThrowaway(
      group,
      'g@test',
      'my-unique-session-id',
      undefined,
      deps,
    );

    const [, input] = mockRunContainerAgent.mock.calls[0];
    expect(input.prompt).toContain('my-unique-session-id');
    expect(input.prompt).toContain('memory/sessions/');
  });
});
