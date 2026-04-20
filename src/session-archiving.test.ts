/**
 * Tests for session-archiving IPC task handlers and helpers.
 * Covers: request_session_archive, spawn_throwaway_session, spawnThrowaway,
 * getSessionJsonlPath, placeholder/archive writing helpers, retry lifecycle,
 * input-size guard, and DB-backed ThrowawaySession persistence.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  _initTestDatabase,
  getThrowawaySessionByForSessionId,
  insertThrowawaySession,
} from './db.js';
import {
  processTaskIpc,
  IpcDeps,
  getSessionJsonlPath,
  spawnThrowaway,
} from './ipc.js';
import {
  DATA_DIR,
  GROUPS_DIR,
  MAX_THROWAWAY_RETRIES,
  THROWAWAY_CONTEXT_LIMIT_TOKENS,
  THROWAWAY_MAX_INPUT_FRACTION,
} from './config.js';
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

afterAll(() => {
  try {
    for (const entry of fs.readdirSync(GROUPS_DIR)) {
      if (entry.includes(TEST_SUFFIX)) {
        fs.rmSync(path.join(GROUPS_DIR, entry), {
          recursive: true,
          force: true,
        });
      }
    }
  } catch {
    /* ignore — dir may not exist */
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

    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const match = input.prompt.match(/memory\/sessions\/([\d-]+\.md)/);
        if (match) {
          fs.writeFileSync(
            path.join(sessDir, match[1]),
            `---\nsession_id: sess-1\ncreated_at: ${new Date().toISOString()}\nis_placeholder: false\n---\n\n# Summary\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

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
    // Container runs under ephemeral group for .claude/ isolation; real folder via hostGroupDir
    expect(calledGroup.folder).toMatch(/^throwaway-/);
    expect(calledInput.groupFolder).toBe(folder); // ContainerInput.groupFolder = real folder
    expect(calledInput.hostGroupDir).toContain(folder);
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
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeJonl(folder, 'sess-real', 3);

    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const match = input.prompt.match(/memory\/sessions\/([\d-]+\.md)/);
        if (match) {
          fs.writeFileSync(
            path.join(sessDir, match[1]),
            `---\nsession_id: sess-real\ncreated_at: ${new Date().toISOString()}\nis_placeholder: false\n---\n\n# Summary\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

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

  it('uses the assistant name (not "Assistant") in archive speaker labels', async () => {
    const folder = testFolder('ra-name');
    const group = makeGroup(folder);
    const setReaction = vi.fn().mockResolvedValue(undefined);

    ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeJonl(folder, 'sess-name', 1);

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
        sessionId: 'sess-name',
        groupFolder: folder,
      },
      folder,
      false,
      deps,
    );

    const convDir = groupDir(path.join(folder, 'conversations'));
    const archiveFile = fs
      .readdirSync(convDir)
      .find((f) => f.endsWith('-reset.md'));
    expect(archiveFile).toBeDefined();
    const content = fs.readFileSync(path.join(convDir, archiveFile!), 'utf-8');
    // Must use the configured assistant name, not the generic "Assistant"
    expect(content).not.toMatch(/\*\*Assistant\*\*:/);
    expect(content).toMatch(/\*\*\w+\*\*: Assistant reply/);
  });

  it('excludes messages already captured by a prior compact archive', async () => {
    const folder = testFolder('ra-dedup');
    const group = makeGroup(folder);
    const setReaction = vi.fn().mockResolvedValue(undefined);

    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    // The "compact" happened at a known time; only messages after it are new.
    const compactAt = new Date('2026-04-15T19:16:21.000Z');
    const oldTs = new Date('2026-04-15T09:00:00.000Z').toISOString();
    const newTs = new Date('2026-04-15T20:00:00.000Z').toISOString();

    // Write a prior compact archive for the same session
    const priorArchive = [
      '---',
      'session_id: sess-dedup',
      `archived_at: ${compactAt.toISOString()}`,
      'source_jsonl: /some/path.jsonl',
      'is_placeholder: false',
      '---',
      '',
      '# Conversation',
      '',
      '**User**: Old message',
      '',
      '**Andy**: Old reply',
      '',
    ].join('\n');
    fs.writeFileSync(
      path.join(convDir, '2026-04-15-1916-compact.md'),
      priorArchive,
    );

    // Write JSONL with one old message (before compact) and one new message (after compact)
    const jonlPath = getSessionJsonlPath(folder, 'sess-dedup');
    fs.mkdirSync(path.dirname(jonlPath), { recursive: true });
    createdDirs.push(path.join(DATA_DIR, 'sessions', folder));
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Old message' },
        session_id: 'sess-dedup',
        timestamp: oldTs,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Old reply' }],
        },
        session_id: 'sess-dedup',
        timestamp: oldTs,
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'New message after compact' },
        session_id: 'sess-dedup',
        timestamp: newTs,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'New reply after compact' }],
        },
        session_id: 'sess-dedup',
        timestamp: newTs,
      }),
    ];
    fs.writeFileSync(jonlPath, lines.join('\n') + '\n');

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
        sessionId: 'sess-dedup',
        groupFolder: folder,
      },
      folder,
      false,
      deps,
    );

    const resetFile = fs
      .readdirSync(convDir)
      .find((f) => f.endsWith('-reset.md'));
    expect(resetFile).toBeDefined();
    const content = fs.readFileSync(path.join(convDir, resetFile!), 'utf-8');

    // Only new content should appear
    expect(content).toContain('New message after compact');
    expect(content).toContain('New reply after compact');
    // Old content from before the compact must be excluded
    expect(content).not.toContain('Old message');
    expect(content).not.toContain('Old reply');
  });
});

// ---------------------------------------------------------------------------
// spawnThrowaway
// ---------------------------------------------------------------------------

describe('spawnThrowaway', () => {
  it('uses a fresh container session (no sessionId)', async () => {
    const folder = testFolder('tw-fresh');
    const group = makeGroup(folder);
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const match = input.prompt.match(/memory\/sessions\/([\d-]+\.md)/);
        if (match) {
          fs.writeFileSync(
            path.join(sessDir, match[1]),
            `---\nsession_id: sess-tw\ncreated_at: ${new Date().toISOString()}\nis_placeholder: false\n---\n\n# Summary\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

    const deps = makeDeps();
    await spawnThrowaway(
      group,
      'g@test',
      'sess-tw',
      '/some/path.jsonl',
      undefined,
      deps,
    );

    expect(mockRunContainerAgent).toHaveBeenCalledOnce();
    const [calledGroup, input] = mockRunContainerAgent.mock.calls[0];
    // Container runs under ephemeral group for .claude/ isolation
    expect(calledGroup.folder).toMatch(/^throwaway-/);
    expect(input.sessionId).toBeUndefined();
    expect(input.isMain).toBe(false);
    expect(input.groupFolder).toBe(folder); // ContainerInput.groupFolder = real folder
    expect(input.chatJid).toBe('g@test');
  });

  it('emits 💭 reaction when container succeeds and summary file is written', async () => {
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
    await spawnThrowaway(
      group,
      'g@test',
      'sess-ok',
      '/path.jsonl',
      undefined,
      deps,
    );

    expect(setReaction).toHaveBeenCalledWith('g@test', '💭');
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
    await spawnThrowaway(
      group,
      'g@test',
      'sess-fail',
      '/path.jsonl',
      undefined,
      deps,
    );

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
      undefined,
      deps,
    );

    const [, input] = mockRunContainerAgent.mock.calls[0];
    expect(input.prompt).toContain('my-unique-session-id');
    expect(input.prompt).toContain('memory/sessions/');
  });

  it('reads conversation archive when archiveFilename is provided', async () => {
    const folder = testFolder('tw-archive');
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
      'sess-arc',
      '/path/to/sess-arc.jsonl',
      '2026-01-01-1200-reset.md',
      deps,
    );

    const [, input] = mockRunContainerAgent.mock.calls[0];
    // Prompt must reference the archive, not the JSONL
    expect(input.prompt).toContain(
      '/workspace/group/conversations/2026-01-01-1200-reset.md',
    );
    expect(input.prompt).not.toContain('.jsonl');
    expect(input.prompt).not.toContain('/home/node/.claude');
  });
});

// ---------------------------------------------------------------------------
// Retry lifecycle
// ---------------------------------------------------------------------------

describe('throwaway retry lifecycle', () => {
  it('retries up to MAX_THROWAWAY_RETRIES times when container never writes summary', async () => {
    const folder = testFolder('retry-exhaust');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    // Container always returns success but never writes the summary file
    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    const setReaction = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ setReaction });
    await spawnThrowaway(
      group,
      'g@test',
      'sess-retry',
      '/path.jsonl',
      undefined,
      deps,
    );

    // Initial + MAX_THROWAWAY_RETRIES retries = MAX_THROWAWAY_RETRIES + 1 total calls
    expect(mockRunContainerAgent).toHaveBeenCalledTimes(
      MAX_THROWAWAY_RETRIES + 1,
    );
  });

  it('writes a failed placeholder summary after retries are exhausted', async () => {
    const folder = testFolder('retry-placeholder');
    const group = makeGroup(folder);
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    const deps = makeDeps();
    await spawnThrowaway(
      group,
      'g@test',
      'sess-exhaust',
      '/path.jsonl',
      undefined,
      deps,
    );

    const files = fs.readdirSync(sessDir);
    expect(files.some((f) => f.endsWith('-failed.md'))).toBe(true);
    const placeholder = fs.readFileSync(
      path.join(sessDir, files.find((f) => f.endsWith('-failed.md'))!),
      'utf-8',
    );
    expect(placeholder).toContain('is_placeholder: true');
    expect(placeholder).toContain('sess-exhaust');
  });

  it('sets ThrowawaySession DB row status=failed after exhausting retries', async () => {
    const folder = testFolder('retry-db');
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
      'sess-db-fail',
      '/path.jsonl',
      undefined,
      deps,
    );

    const row = getThrowawaySessionByForSessionId('sess-db-fail');
    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.retry_count).toBe(MAX_THROWAWAY_RETRIES);
  });

  it('sets ThrowawaySession DB row status=completed on success', async () => {
    const folder = testFolder('retry-db-ok');
    const group = makeGroup(folder);
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const match = input.prompt.match(/memory\/sessions\/([\d-]+\.md)/);
        if (match) {
          fs.writeFileSync(
            path.join(sessDir, match[1]),
            `---\nsession_id: sess-db-ok\ncreated_at: ${new Date().toISOString()}\nis_placeholder: false\n---\n\n# Summary\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

    const deps = makeDeps();
    await spawnThrowaway(
      group,
      'g@test',
      'sess-db-ok',
      '/path.jsonl',
      undefined,
      deps,
    );

    const row = getThrowawaySessionByForSessionId('sess-db-ok');
    expect(row).toBeDefined();
    expect(row!.status).toBe('completed');
    expect(row!.retry_count).toBe(0);
  });

  it('notifies main group when retries exhausted', async () => {
    const mainFolder = testFolder('retry-main');
    const mainGroup = makeGroup(mainFolder);
    (mainGroup as RegisteredGroup & { isMain: boolean }).isMain = true;
    const targetFolder = testFolder('retry-target');
    const targetGroup = makeGroup(targetFolder);
    ensureDir(GROUPS_DIR, targetFolder, 'memory', 'sessions');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      sendMessage,
      registeredGroups: () => ({
        'main@test': mainGroup,
        'g@test': targetGroup,
      }),
    });
    await spawnThrowaway(
      targetGroup,
      'g@test',
      'sess-notify',
      '/path.jsonl',
      undefined,
      deps,
    );
    // sendMessage is two awaits deep in the exhaustion path (after setReaction);
    // flush all pending microtasks via a macrotask boundary before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessage).toHaveBeenCalledWith(
      'main@test',
      expect.stringContaining('sess-notify'),
    );
  });
});

// ---------------------------------------------------------------------------
// Input-size guard
// ---------------------------------------------------------------------------

describe('input-size guard', () => {
  const oversizedBytes = Math.ceil(
    THROWAWAY_CONTEXT_LIMIT_TOKENS * THROWAWAY_MAX_INPUT_FRACTION * 4 + 1000,
  );

  function writeOversizedJonl(folder: string, sessionId: string): string {
    const jonlPath = getSessionJsonlPath(folder, sessionId);
    fs.mkdirSync(path.dirname(jonlPath), { recursive: true });
    const sessionGroupDir = path.join(DATA_DIR, 'sessions', folder);
    if (!createdDirs.includes(sessionGroupDir))
      createdDirs.push(sessionGroupDir);
    fs.writeFileSync(jonlPath, 'x'.repeat(oversizedBytes));
    return jonlPath;
  }

  it('spawn_throwaway_session: blocks throwaway and writes oversized placeholder when JSONL too large and no archive', async () => {
    const folder = testFolder('size-guard-post');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeOversizedJonl(folder, 'sess-oversized');

    const setReaction = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
      setReaction,
    });

    await processTaskIpc(
      {
        type: 'spawn_throwaway_session',
        jid: 'g@test',
        sessionId: 'sess-oversized',
        groupFolder: folder,
        jsonlPath: getSessionJsonlPath(folder, 'sess-oversized'),
      },
      folder,
      false,
      deps,
    );

    expect(mockRunContainerAgent).not.toHaveBeenCalled();
    expect(setReaction).toHaveBeenCalledWith('g@test', '💭');

    const sessDir = path.join(GROUPS_DIR, folder, 'memory', 'sessions');
    const files = fs.readdirSync(sessDir);
    expect(files.some((f) => f.endsWith('-oversized.md'))).toBe(true);

    const row = getThrowawaySessionByForSessionId('sess-oversized');
    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.retry_count).toBe(MAX_THROWAWAY_RETRIES);
    const signals = JSON.parse(row!.failure_signals!);
    expect(signals.input_too_large).toBe(true);
  });

  it('request_session_archive: spawns throwaway using archive even when JSONL too large', async () => {
    const folder = testFolder('size-guard-reset');
    const group = makeGroup(folder);
    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    // Write a real JSONL with messages so the archive write path is taken
    // (overwrite with oversized content — but the throwaway reads the archive, not the JSONL)
    const jonlPath = getSessionJsonlPath(folder, 'sess-reset-big');
    fs.mkdirSync(path.dirname(jonlPath), { recursive: true });
    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      session_id: 'sess-reset-big',
    });
    fs.writeFileSync(jonlPath, msg + '\n' + 'x'.repeat(oversizedBytes));

    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const match = input.prompt.match(/memory\/sessions\/([\d-]+\.md)/);
        if (match) {
          fs.writeFileSync(
            path.join(sessDir, match[1]),
            `---\nsession_id: sess-reset-big\ncreated_at: ${new Date().toISOString()}\nis_placeholder: false\n---\n\n# Summary\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-reset-big',
        groupFolder: folder,
      },
      folder,
      false,
      deps,
    );

    // Archive is written
    const archiveFiles = fs.readdirSync(convDir);
    expect(archiveFiles.some((f) => f.endsWith('-reset.md'))).toBe(true);

    // Container IS launched (throwaway uses the archive, not the raw JSONL)
    expect(mockRunContainerAgent).toHaveBeenCalled();
    const promptArg = mockRunContainerAgent.mock.calls[0][1].prompt as string;
    expect(promptArg).toContain('conversations/');
    expect(promptArg).not.toContain('.jsonl');

    // No oversized placeholder
    const sessFiles = fs.readdirSync(sessDir);
    expect(sessFiles.some((f) => f.endsWith('-oversized.md'))).toBe(false);
  });

  it('spawn_throwaway_session: launches throwaway normally when archive already exists', async () => {
    const folder = testFolder('size-guard-with-archive');
    const group = makeGroup(folder);
    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeOversizedJonl(folder, 'sess-has-archive');

    // Write an existing (non-placeholder) archive
    const archiveFile = '2026-01-01-1200-reset.md';
    fs.writeFileSync(
      path.join(convDir, archiveFile),
      `---\nsession_id: sess-has-archive\narchived_at: ${new Date().toISOString()}\nsource_jsonl: /path\nis_placeholder: false\n---\n\n# Conversation\n`,
    );

    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const match = input.prompt.match(/memory\/sessions\/([\d-]+\.md)/);
        if (match) {
          fs.writeFileSync(
            path.join(sessDir, match[1]),
            `---\nsession_id: sess-has-archive\ncreated_at: ${new Date().toISOString()}\nis_placeholder: false\n---\n\n# Summary\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

    const deps = makeDeps({
      registeredGroups: () => ({ 'g@test': group }),
    });

    await processTaskIpc(
      {
        type: 'spawn_throwaway_session',
        jid: 'g@test',
        sessionId: 'sess-has-archive',
        groupFolder: folder,
        jsonlPath: getSessionJsonlPath(folder, 'sess-has-archive'),
      },
      folder,
      false,
      deps,
    );

    await new Promise((r) => setTimeout(r, 0));
    // Archive exists → no size check → throwaway launched
    expect(mockRunContainerAgent).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// archive_datetime-based summary filenames (gap 4)
// ---------------------------------------------------------------------------

describe('archive_datetime-based summary filename', () => {
  /** Write a non-placeholder archive with a specific archived_at timestamp. */
  function writeArchive(
    convDir: string,
    sessionId: string,
    archivedAt: string,
    filename: string,
  ): void {
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(
      path.join(convDir, filename),
      `---\nsession_id: ${sessionId}\narchived_at: ${archivedAt}\nmessages_since: null\ntrigger_type: compact\nis_placeholder: false\n---\n\n# Conversation\n`,
    );
  }

  it('uses archived_at of existing archive as summary filename prefix', async () => {
    const folder = testFolder('tw-archdt');
    const group = makeGroup(folder);
    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeArchive(
      convDir,
      'sess-archdt',
      '2026-01-15T14:30:00.000Z',
      '2026-01-15-1430-compact.md',
    );

    let capturedFilename: string | null = null;
    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const m = input.prompt.match(/memory\/sessions\/(\S+\.md)/);
        if (m) {
          capturedFilename = m[1];
          fs.writeFileSync(
            path.join(sessDir, m[1]),
            `---\nsession_id: sess-archdt\nis_placeholder: false\n---\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

    await spawnThrowaway(
      group,
      'g@test',
      'sess-archdt',
      undefined,
      undefined,
      deps(),
    );
    expect(capturedFilename).toBe('2026-01-15-1430.md');

    function deps() {
      return makeDeps();
    }
  });

  it('adds -processed-at- suffix on second run (retry_count > 0)', async () => {
    const folder = testFolder('tw-archdt-retry');
    const group = makeGroup(folder);
    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeArchive(
      convDir,
      'sess-archdt-retry',
      '2026-01-15T14:30:00.000Z',
      '2026-01-15-1430-compact.md',
    );

    const filenames: string[] = [];
    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const m = input.prompt.match(/memory\/sessions\/(\S+\.md)/);
        if (m) filenames.push(m[1]);
        // never write file → forces retries
        return { status: 'success', result: null };
      },
    );

    await spawnThrowaway(
      group,
      'g@test',
      'sess-archdt-retry',
      undefined,
      undefined,
      makeDeps(),
    );

    // First attempt uses the plain archive_datetime filename
    expect(filenames[0]).toBe('2026-01-15-1430.md');
    // All subsequent attempts get the -processed-at- suffix
    for (const f of filenames.slice(1)) {
      expect(f).toMatch(/^2026-01-15-1430-processed-at-[\d-]+\.md$/);
    }
  });

  it('falls back to current time when no archive exists', async () => {
    const folder = testFolder('tw-archdt-fallback');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'conversations'); // empty
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    let capturedFilename: string | null = null;
    mockRunContainerAgent.mockImplementation(
      async (_g: unknown, input: { prompt: string }) => {
        const m = input.prompt.match(/memory\/sessions\/(\S+\.md)/);
        if (m) {
          capturedFilename = m[1];
          fs.writeFileSync(
            path.join(sessDir, m[1]),
            `---\nsession_id: sess-fallback\nis_placeholder: false\n---\n`,
          );
        }
        return { status: 'success', result: null };
      },
    );

    await spawnThrowaway(
      group,
      'g@test',
      'sess-fallback',
      undefined,
      undefined,
      makeDeps(),
    );
    // Falls back to current date — just check it looks like a date-based filename
    expect(capturedFilename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  });
});

// ---------------------------------------------------------------------------
// trigger_type and was_manual_retry DB fields (gaps 2 & 3)
// ---------------------------------------------------------------------------

describe('trigger_type and was_manual_retry DB fields', () => {
  it('spawnThrowaway sets trigger_type=compact by default', async () => {
    const folder = testFolder('tw-tt-compact');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });
    await spawnThrowaway(
      group,
      'g@test',
      'sess-tt-compact',
      undefined,
      undefined,
      makeDeps(),
    );

    const row = getThrowawaySessionByForSessionId('sess-tt-compact');
    expect(row?.trigger_type).toBe('compact');
    expect(row?.was_manual_retry).toBe(0);
  });

  it('spawnThrowaway stores trigger_type=reset when passed', async () => {
    const folder = testFolder('tw-tt-reset');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });
    await spawnThrowaway(
      group,
      'g@test',
      'sess-tt-reset',
      undefined,
      undefined,
      makeDeps(),
      'reset',
    );

    const row = getThrowawaySessionByForSessionId('sess-tt-reset');
    expect(row?.trigger_type).toBe('reset');
  });

  it('request_session_archive stores trigger_type=reset in DB row', async () => {
    const folder = testFolder('tw-tt-arc-reset');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeJonl(folder, 'sess-arc-reset');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-arc-reset',
        groupFolder: folder,
      },
      folder,
      false,
      makeDeps({ registeredGroups: () => ({ 'g@test': group }) }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const row = getThrowawaySessionByForSessionId('sess-arc-reset');
    expect(row?.trigger_type).toBe('reset');
  });

  it('retry_throwaway_summary sets was_manual_retry=1 in DB', async () => {
    const folder = testFolder('tw-manual-retry');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    // Insert a failed throwaway row directly
    const rowId = 'test-manual-retry-id';
    insertThrowawaySession({
      id: rowId,
      for_session_id: 'sess-manual',
      group_folder: folder,
      chat_jid: 'g@test',
      ephemeral_group_id: 'throwaway-test',
      log_path: null,
      retry_count: MAX_THROWAWAY_RETRIES,
      failure_signals: null,
      status: 'failed',
      started_at: new Date().toISOString(),
      was_manual_retry: 0,
      trigger_type: 'compact',
      source_input: '',
    });

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await processTaskIpc(
      {
        type: 'retry_throwaway_summary',
        jid: 'g@test',
        sessionId: 'sess-manual',
        groupFolder: folder,
      },
      folder,
      false,
      makeDeps({ registeredGroups: () => ({ 'g@test': group }) }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const row = getThrowawaySessionByForSessionId('sess-manual');
    expect(row?.was_manual_retry).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Enriched placeholder frontmatter (gaps 6 & 7)
// ---------------------------------------------------------------------------

describe('enriched placeholder frontmatter', () => {
  it('failed placeholder contains log_path, failure_signals, source_jsonl, retry_count', async () => {
    const folder = testFolder('tw-fail-fm');
    const group = makeGroup(folder);
    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    // Write archive so filename is deterministic
    const archivedAt = '2026-02-10T10:00:00.000Z';
    fs.writeFileSync(
      path.join(convDir, '2026-02-10-1000-compact.md'),
      `---\nsession_id: sess-fail-fm\narchived_at: ${archivedAt}\nis_placeholder: false\n---\n`,
    );

    // Container never writes summary → exhaust retries
    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await spawnThrowaway(
      group,
      'g@test',
      'sess-fail-fm',
      undefined,
      undefined,
      makeDeps(),
    );

    const files = fs.readdirSync(sessDir);
    const failedFile = files.find((f) => f.endsWith('-failed.md'));
    expect(failedFile).toBeDefined();
    expect(failedFile).toBe('2026-02-10-1000-failed.md');

    const content = fs.readFileSync(path.join(sessDir, failedFile!), 'utf-8');
    expect(content).toContain('retry_count:');
    expect(content).toContain('log_path:');
    expect(content).toContain('source_jsonl:');
    expect(content).toContain('failure_signals:');
  });

  it('oversized placeholder contains failure_signals and retry_count', async () => {
    const folder = testFolder('tw-oversized-fm');
    const group = makeGroup(folder);
    ensureDir(GROUPS_DIR, folder, 'conversations');
    const sessDir = ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');

    const oversizedBytes = Math.ceil(
      THROWAWAY_CONTEXT_LIMIT_TOKENS * THROWAWAY_MAX_INPUT_FRACTION * 4 + 1000,
    );
    const jonlPath = getSessionJsonlPath(folder, 'sess-oversized-fm');
    fs.mkdirSync(path.dirname(jonlPath), { recursive: true });
    createdDirs.push(path.join(DATA_DIR, 'sessions', folder));
    fs.writeFileSync(jonlPath, 'x'.repeat(oversizedBytes));

    await processTaskIpc(
      {
        type: 'spawn_throwaway_session',
        jid: 'g@test',
        sessionId: 'sess-oversized-fm',
        groupFolder: folder,
        jsonlPath: jonlPath,
      },
      folder,
      false,
      makeDeps({ registeredGroups: () => ({ 'g@test': group }) }),
    );

    const files = fs.readdirSync(sessDir);
    const oversizedFile = files.find((f) => f.endsWith('-oversized.md'));
    expect(oversizedFile).toBeDefined();

    const content = fs.readFileSync(
      path.join(sessDir, oversizedFile!),
      'utf-8',
    );
    expect(content).toContain('failure_signals:');
    expect(content).toContain('retry_count:');
    expect(content).toContain('source_jsonl:');
  });
});

// ---------------------------------------------------------------------------
// Archive frontmatter: messages_since and trigger_type (gap 8 & gap 2)
// ---------------------------------------------------------------------------

describe('archive frontmatter fields', () => {
  it('writes messages_since: null and trigger_type: reset in reset archive', async () => {
    const folder = testFolder('arc-fm-reset');
    const group = makeGroup(folder);
    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeJonl(folder, 'sess-arc-fm');

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-arc-fm',
        groupFolder: folder,
      },
      folder,
      false,
      makeDeps({ registeredGroups: () => ({ 'g@test': group }) }),
    );

    const files = fs.readdirSync(convDir);
    const archiveFile = files.find((f) => f.endsWith('-reset.md'));
    expect(archiveFile).toBeDefined();

    const content = fs.readFileSync(path.join(convDir, archiveFile!), 'utf-8');
    expect(content).toContain('messages_since: null');
    expect(content).toContain('trigger_type: reset');
  });

  it('writes messages_since with prior archive timestamp when prior archive exists', async () => {
    const folder = testFolder('arc-fm-messages-since');
    const group = makeGroup(folder);
    const convDir = ensureDir(GROUPS_DIR, folder, 'conversations');
    ensureDir(GROUPS_DIR, folder, 'memory', 'sessions');
    writeJonl(folder, 'sess-arc-ms');

    // Write a prior non-placeholder archive
    const priorAt = '2026-03-01T09:00:00.000Z';
    fs.writeFileSync(
      path.join(convDir, '2026-03-01-0900-reset.md'),
      `---\nsession_id: sess-arc-ms\narchived_at: ${priorAt}\nis_placeholder: false\n---\n`,
    );

    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });

    await processTaskIpc(
      {
        type: 'request_session_archive',
        jid: 'g@test',
        sessionId: 'sess-arc-ms',
        groupFolder: folder,
      },
      folder,
      false,
      makeDeps({ registeredGroups: () => ({ 'g@test': group }) }),
    );

    const files = fs.readdirSync(convDir);
    const newArchive = files.filter(
      (f) => f.endsWith('-reset.md') && !f.startsWith('2026-03-01'),
    );
    expect(newArchive).toHaveLength(1);

    const content = fs.readFileSync(path.join(convDir, newArchive[0]), 'utf-8');
    expect(content).toContain(`messages_since: ${priorAt}`);
  });
});

// ---------------------------------------------------------------------------
// query_failed_summaries IPC handler (gap 1)
// ---------------------------------------------------------------------------

describe('query_failed_summaries IPC handler', () => {
  afterEach(() => {
    // Clean up any response files written under DATA_DIR/ipc/
    try {
      const ipcBase = path.join(DATA_DIR, 'ipc');
      for (const entry of fs.readdirSync(ipcBase)) {
        if (entry.includes(TEST_SUFFIX)) {
          fs.rmSync(path.join(ipcBase, entry), {
            recursive: true,
            force: true,
          });
        }
      }
    } catch {
      /* ignore */
    }
  });

  it('returns failed sessions for the requesting group', async () => {
    const folder = testFolder('qfs-group');
    ensureDir(GROUPS_DIR, folder, 'conversations');

    insertThrowawaySession({
      id: 'qfs-row-1',
      for_session_id: 'sess-qfs-1',
      group_folder: folder,
      chat_jid: 'g@test',
      ephemeral_group_id: 'throwaway-qfs',
      log_path: null,
      retry_count: MAX_THROWAWAY_RETRIES,
      failure_signals: JSON.stringify({
        timed_out_without_output: false,
        triggered_own_compact: false,
        api_error: null,
        input_too_large: true,
      }),
      status: 'failed',
      started_at: new Date().toISOString(),
      was_manual_retry: 0,
      trigger_type: 'compact',
      source_input: '',
    });

    const requestId = 'test-req-1';
    await processTaskIpc(
      { type: 'query_failed_summaries', requestId, groupFolder: folder },
      folder,
      false,
      makeDeps(),
    );

    const responseFile = path.join(
      DATA_DIR,
      'ipc',
      folder,
      'responses',
      `${requestId}.json`,
    );
    expect(fs.existsSync(responseFile)).toBe(true);

    const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(result.failed_summaries).toHaveLength(1);
    expect(result.failed_summaries[0].session_id).toBe('sess-qfs-1');
    expect(result.failed_summaries[0].trigger_type).toBe('compact');
    expect(result.failed_summaries[0].retry_count).toBe(MAX_THROWAWAY_RETRIES);
    expect(result.failed_summaries[0].failure_signals).not.toBeNull();
  });

  it('does not include failed sessions from other groups', async () => {
    const folderA = testFolder('qfs-a');
    const folderB = testFolder('qfs-b');
    ensureDir(GROUPS_DIR, folderA, 'conversations');
    ensureDir(GROUPS_DIR, folderB, 'conversations');

    insertThrowawaySession({
      id: 'qfs-row-a',
      for_session_id: 'sess-qfs-a',
      group_folder: folderA,
      chat_jid: 'ga@test',
      ephemeral_group_id: 'throwaway-qfs-a',
      log_path: null,
      retry_count: MAX_THROWAWAY_RETRIES,
      failure_signals: null,
      status: 'failed',
      started_at: new Date().toISOString(),
      was_manual_retry: 0,
      trigger_type: 'reset',
      source_input: '',
    });

    const requestId = 'test-req-b';
    // Request from folderB — should get empty list
    await processTaskIpc(
      { type: 'query_failed_summaries', requestId, groupFolder: folderB },
      folderB,
      false,
      makeDeps(),
    );

    const responseFile = path.join(
      DATA_DIR,
      'ipc',
      folderB,
      'responses',
      `${requestId}.json`,
    );
    const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(result.failed_summaries).toHaveLength(0);
  });

  it('returns empty list when no failed sessions exist', async () => {
    const folder = testFolder('qfs-empty');
    ensureDir(GROUPS_DIR, folder, 'conversations');

    const requestId = 'test-req-empty';
    await processTaskIpc(
      { type: 'query_failed_summaries', requestId, groupFolder: folder },
      folder,
      false,
      makeDeps(),
    );

    const responseFile = path.join(
      DATA_DIR,
      'ipc',
      folder,
      'responses',
      `${requestId}.json`,
    );
    const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
    expect(result.failed_summaries).toHaveLength(0);
  });
});
