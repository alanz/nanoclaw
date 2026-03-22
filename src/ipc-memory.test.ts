/**
 * Tests for memory_search, memory_get, memory_list IPC task handlers.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// ---- Mocks ----

vi.mock('./memory/manager.js', () => ({
  getOrCreateMemoryManager: vi.fn(),
  closeAllMemoryManagers: vi.fn(),
  formatMemoryContext: vi.fn(),
}));

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return { ...actual, MEMORY_SEARCH_ENABLED: true };
});

import { getOrCreateMemoryManager } from './memory/manager.js';

// ---- Fixtures ----

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

// Capture writeFileSync calls to read back response payloads without touching disk
let writtenFiles: Map<string, string>;

beforeEach(() => {
  _initTestDatabase();

  groups = { 'main@g.us': MAIN_GROUP };
  setRegisteredGroup('main@g.us', MAIN_GROUP);

  writtenFiles = new Map();
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'writeFileSync').mockImplementation((filePath, data) => {
    writtenFiles.set(String(filePath), String(data));
  });

  deps = {
    sendMessage: async () => {},
    sendFile: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    setGroupTrusted: () => {},
    syncGroups: async () => {},
    startRemoteControl: async () => ({ ok: false as const, error: 'not impl' }),
    stopRemoteControl: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- Helpers ----

function getWrittenResponse(requestId: string): unknown {
  for (const [filePath, content] of writtenFiles) {
    if (filePath.endsWith(`${requestId}.json`)) {
      return JSON.parse(content);
    }
  }
  throw new Error(
    `No response file written for requestId=${requestId}. Written: ${[...writtenFiles.keys()].join(', ')}`,
  );
}

// ---- memory_search ----

describe('memory_search IPC', () => {
  it('returns error when manager not available', async () => {
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue(null);

    await processTaskIpc(
      { type: 'memory_search', requestId: 'req-1', query: 'test query' },
      'main',
      true,
      deps,
    );

    const resp = getWrittenResponse('req-1') as { error: string };
    expect(resp.error).toMatch(/not available/i);
  });

  it('returns search results from manager', async () => {
    const mockSearch = vi.fn(async () => [
      {
        path: 'notes/foo.md',
        startLine: 1,
        endLine: 5,
        score: 0.9,
        snippet: 'hello world',
      },
    ]);
    const mockMgr = { search: mockSearch, totalIndexed: vi.fn(() => 42) };
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue(mockMgr as never);

    await processTaskIpc(
      {
        type: 'memory_search',
        requestId: 'req-2',
        query: 'hello',
        limit: 3,
        min_score: 0.5,
      },
      'main',
      true,
      deps,
    );

    const resp = getWrittenResponse('req-2') as {
      results: unknown[];
      total_indexed: number;
      query_used: string;
    };
    expect(resp.results).toHaveLength(1);
    expect(resp.total_indexed).toBe(42);
    expect(resp.query_used).toBe('hello');
    expect(mockSearch).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ maxResults: 3, minScore: 0.5 }),
    );
  });

  it('passes pathPrefix and source opts to search', async () => {
    const mockSearch = vi.fn(async () => []);
    const mockMgr = { search: mockSearch, totalIndexed: vi.fn(() => 0) };
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue(mockMgr as never);

    await processTaskIpc(
      {
        type: 'memory_search',
        requestId: 'req-3',
        query: 'q',
        path_prefix: 'memory/notes/',
        source: 'memory',
      },
      'main',
      true,
      deps,
    );

    expect(mockSearch).toHaveBeenCalledWith(
      'q',
      expect.objectContaining({
        pathPrefix: 'memory/notes/',
        source: 'memory',
      }),
    );
  });

  it('skips when requestId or query missing', async () => {
    await processTaskIpc(
      { type: 'memory_search', requestId: 'req-x' /* no query */ },
      'main',
      true,
      deps,
    );

    // No response file written for this requestId
    expect([...writtenFiles.keys()].some((p) => p.endsWith('req-x.json'))).toBe(
      false,
    );
  });
});

// ---- memory_get ----

describe('memory_get IPC', () => {
  it('returns error when manager not available', async () => {
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue(null);

    await processTaskIpc(
      { type: 'memory_get', requestId: 'get-1', path: 'notes/foo.md' },
      'main',
      true,
      deps,
    );

    const resp = getWrittenResponse('get-1') as { error: string };
    expect(resp.error).toMatch(/not available/i);
  });

  it('returns file content from manager', async () => {
    const mockGetFileContent = vi.fn(async () => ({
      path: 'notes/foo.md',
      content: 'File content here',
      size: 100,
      indexed: true,
      lastIndexed: 1234567890,
      frontmatter: { id: 'MEM-test' },
    }));
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue({
      getFileContent: mockGetFileContent,
    } as never);

    await processTaskIpc(
      { type: 'memory_get', requestId: 'get-2', path: 'notes/foo.md' },
      'main',
      true,
      deps,
    );

    const resp = getWrittenResponse('get-2') as {
      content: string;
      frontmatter: unknown;
    };
    expect(resp.content).toBe('File content here');
    expect(resp.frontmatter).toEqual({ id: 'MEM-test' });
  });

  it('returns error string when getFileContent throws', async () => {
    const mockGetFileContent = vi.fn(async () => {
      throw new Error('File not found: missing.md');
    });
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue({
      getFileContent: mockGetFileContent,
    } as never);

    await processTaskIpc(
      { type: 'memory_get', requestId: 'get-3', path: 'missing.md' },
      'main',
      true,
      deps,
    );

    const resp = getWrittenResponse('get-3') as { error: string };
    expect(resp.error).toContain('File not found');
  });
});

// ---- memory_list ----

describe('memory_list IPC', () => {
  it('returns error when manager not available', async () => {
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue(null);

    await processTaskIpc(
      { type: 'memory_list', requestId: 'list-1' },
      'main',
      true,
      deps,
    );

    const resp = getWrittenResponse('list-1') as { error: string };
    expect(resp.error).toMatch(/not available/i);
  });

  it('returns file list from manager', async () => {
    const mockListFiles = vi.fn(() => ({
      files: [
        { path: 'notes/a.md', mtime: 1000, size: 50, indexed: true },
        { path: 'notes/b.md', mtime: 900, size: 30, indexed: true },
      ],
      total: 2,
    }));
    vi.mocked(getOrCreateMemoryManager).mockResolvedValue({
      listFiles: mockListFiles,
    } as never);

    await processTaskIpc(
      {
        type: 'memory_list',
        requestId: 'list-2',
        path_prefix: 'notes/',
        limit: 10,
        order_by: 'mtime',
      },
      'main',
      true,
      deps,
    );

    const resp = getWrittenResponse('list-2') as {
      files: unknown[];
      total: number;
    };
    expect(resp.total).toBe(2);
    expect(resp.files).toHaveLength(2);
    expect(mockListFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        pathPrefix: 'notes/',
        limit: 10,
        orderBy: 'mtime',
      }),
    );
  });

  it('skips when requestId missing', async () => {
    await processTaskIpc(
      { type: 'memory_list' /* no requestId */ },
      'main',
      true,
      deps,
    );

    // No response file written
    expect(writtenFiles.size).toBe(0);
  });
});
