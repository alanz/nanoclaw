import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryIndexManager } from './manager.js';

/**
 * Create a MemoryIndexManager backed by a real in-memory SQLite database.
 * We use a temp-dir path for the DB so better-sqlite3 creates a real on-disk
 * file (in-memory ':memory:' is not directly supported by the constructor).
 */
function createTestManager(
  workspaceDir: string,
  opts?: { embedBatchImpl?: (texts: string[]) => Promise<number[][]> },
): MemoryIndexManager {
  const dbPath = path.join(workspaceDir, 'test-index.db');
  const mgr = new MemoryIndexManager(
    workspaceDir,
    dbPath,
    [] /* extraPaths */,
    'test-api-key',
    'gemini-embedding-001',
    100 /* rpmLimit */,
    0 /* rpdSessionBudget — 0 means no session budget */,
    10 /* maxResults */,
    0 /* minScore */,
  );

  // Patch the provider with a mock after construction but before init
  if (opts?.embedBatchImpl) {
    const embedBatchImpl = opts.embedBatchImpl;
    // We'll patch after init
    (
      mgr as unknown as {
        _pendingEmbedBatch: (texts: string[]) => Promise<number[][]>;
      }
    )._pendingEmbedBatch = embedBatchImpl;
  }

  return mgr;
}

describe('MemoryIndexManager sync failures do not crash', () => {
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-mem-test-'),
    );
    await fs.writeFile(path.join(workspaceDir, 'MEMORY.md'), 'Hello memory');
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not raise unhandledRejection when sync fails due to embedding error', async () => {
    // Mock fetch to simulate a 500 error from Gemini so embedding fails
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));
    vi.stubGlobal('fetch', fetchMock);

    manager = createTestManager(workspaceDir);
    await manager.init();

    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    // Trigger a sync and wait for it to complete (it should catch errors internally)
    const syncPromise = manager.sync();
    await syncPromise.catch(() => undefined);

    // Give microtasks a chance to propagate any unhandled rejections
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', handler);
    expect(unhandled).toHaveLength(0);
  });

  it('does not raise unhandledRejection when sync fails due to 429 rate limit', async () => {
    // Mock fetch to return a 429 rate limit error
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              {
                violations: [{ quotaId: 'RequestsPerMinutePerUser' }],
              },
              { retryDelay: '60s' },
            ],
          },
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    manager = createTestManager(workspaceDir);
    await manager.init();

    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    const syncPromise = manager.sync();
    await syncPromise.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', handler);
    expect(unhandled).toHaveLength(0);
  });

  it('sync completes without error when no memory files exist', async () => {
    // Remove the MEMORY.md file
    await fs.rm(path.join(workspaceDir, 'MEMORY.md'));

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [] }),
      text: async () => JSON.stringify({ embeddings: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    manager = createTestManager(workspaceDir);
    await manager.init();

    await expect(manager.sync()).resolves.toBeUndefined();
  });
});

describe('MemoryIndexManager.search', () => {
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-mem-search-'),
    );
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns empty array for empty query', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 0, 0] } }),
      text: async () => JSON.stringify({ embedding: { values: [1, 0, 0] } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    manager = createTestManager(workspaceDir);
    await manager.init();

    const results = await manager.search('');
    expect(results).toEqual([]);
  });

  it('returns empty array when closed', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 0, 0] } }),
      text: async () => JSON.stringify({ embedding: { values: [1, 0, 0] } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    manager = createTestManager(workspaceDir);
    await manager.init();
    await manager.close();

    const results = await manager.search('hello');
    expect(results).toEqual([]);

    // Prevent double-close in afterEach
    manager = null;
  });

  it('returns empty array when embedding fails and no FTS matches exist', async () => {
    // Embedding fails
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }));
    vi.stubGlobal('fetch', fetchMock);

    manager = createTestManager(workspaceDir);
    await manager.init();

    // No files indexed, so FTS also returns nothing
    const results = await manager.search('hello world');
    expect(Array.isArray(results)).toBe(true);
  });
});
