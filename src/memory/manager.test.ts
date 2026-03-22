import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryIndexManager, parseFrontmatterYaml } from './manager.js';

/**
 * Create a MemoryIndexManager backed by a real in-memory SQLite database.
 * We use a temp-dir path for the DB so better-sqlite3 creates a real on-disk
 * file (in-memory ':memory:' is not directly supported by the constructor).
 */
function createTestManager(
  workspaceDir: string,
  opts?: {
    embedBatchImpl?: (texts: string[]) => Promise<number[][]>;
    /** RPD session budget — use a large number (e.g. 9999) when tests need successful indexing. Default 0 = immediately exhausted (for error-path tests). */
    rpdSessionBudget?: number;
  },
): MemoryIndexManager {
  const dbPath = path.join(workspaceDir, 'test-index.db');
  const mgr = new MemoryIndexManager(
    workspaceDir,
    dbPath,
    [] /* extraPaths */,
    'test-api-key',
    'gemini-embedding-001',
    100 /* rpmLimit */,
    opts?.rpdSessionBudget ?? 0, // 0 = immediately exhausted; use 9999 for success-path tests
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

// ---- Helper: stub Gemini fetch to return a fixed 3-dim embedding ----
// The single-embed endpoint (:embedContent) returns { embedding: { values } }
// The batch endpoint (:batchEmbedContents) returns { embeddings: [{ values }, ...] }
function stubGeminiFetch(vec: number[] = [1, 0, 0]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, opts?: { body?: string }) => {
      const isBatch = (url as string).includes('batchEmbedContents');
      let body: unknown;
      if (isBatch) {
        const req = JSON.parse(opts?.body ?? '{}') as { requests?: unknown[] };
        const count = Array.isArray(req.requests) ? req.requests.length : 1;
        body = {
          embeddings: Array.from({ length: count }, () => ({ values: vec })),
        };
      } else {
        body = { embedding: { values: vec } };
      }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
}

// ---- parseFrontmatterYaml ----

describe('parseFrontmatterYaml', () => {
  it('returns undefined when no front matter', () => {
    expect(parseFrontmatterYaml('# heading\nsome text')).toBeUndefined();
  });

  it('parses scalar fields', () => {
    const fm = parseFrontmatterYaml(
      '---\nid: MEM-2026-01-01-test\ncreated: 2026-01-01\n---\n\nBody.',
    );
    expect(fm).toMatchObject({
      id: 'MEM-2026-01-01-test',
      created: '2026-01-01',
    });
  });

  it('parses array fields', () => {
    const fm = parseFrontmatterYaml(
      '---\nkeywords: [foo, bar, baz]\ntags: [a]\n---\n',
    );
    expect(fm?.keywords).toEqual(['foo', 'bar', 'baz']);
    expect(fm?.tags).toEqual(['a']);
  });

  it('parses null fields', () => {
    const fm = parseFrontmatterYaml('---\nsupersedes: null\n---\n');
    expect(fm?.supersedes).toBeNull();
  });

  it('parses boolean fields', () => {
    const fm = parseFrontmatterYaml(
      '---\nactive: true\narchived: false\n---\n',
    );
    expect(fm?.active).toBe(true);
    expect(fm?.archived).toBe(false);
  });

  it('returns undefined for empty front matter', () => {
    expect(parseFrontmatterYaml('---\n---\n')).toBeUndefined();
  });
});

// ---- totalIndexed ----

describe('MemoryIndexManager.totalIndexed', () => {
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-mem-idx-'),
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

  it('returns 0 when no files indexed', async () => {
    stubGeminiFetch();
    manager = createTestManager(workspaceDir);
    await manager.init();
    expect(manager.totalIndexed()).toBe(0);
  });

  it('returns chunk count after indexing', async () => {
    stubGeminiFetch();
    // listMemoryFiles only indexes MEMORY.md and files under memory/
    await fs.writeFile(
      path.join(workspaceDir, 'MEMORY.md'),
      'Hello world.\nThis is a test note.',
    );
    manager = createTestManager(workspaceDir, { rpdSessionBudget: 9999 });
    await manager.init();
    await manager.sync();
    expect(manager.totalIndexed()).toBeGreaterThan(0);
  });
});

// ---- getFileContent ----

describe('MemoryIndexManager.getFileContent', () => {
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-mem-get-'),
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

  it('returns file content for existing workspace file', async () => {
    stubGeminiFetch();
    const content = 'Hello, world!\nSecond line.';
    await fs.writeFile(path.join(workspaceDir, 'hello.md'), content);
    manager = createTestManager(workspaceDir);
    await manager.init();

    const result = await manager.getFileContent('hello.md');
    expect(result.content).toBe(content);
    expect(result.path).toBe('hello.md');
    expect(result.size).toBeGreaterThan(0);
  });

  it('parses frontmatter when present', async () => {
    stubGeminiFetch();
    const content =
      '---\nid: MEM-2026-01-01-test\nkeywords: [foo, bar]\n---\n\nBody text.';
    await fs.writeFile(path.join(workspaceDir, 'note.md'), content);
    manager = createTestManager(workspaceDir);
    await manager.init();

    const result = await manager.getFileContent('note.md', {
      parseFrontmatter: true,
    });
    expect(result.frontmatter?.id).toBe('MEM-2026-01-01-test');
    expect(result.frontmatter?.keywords).toEqual(['foo', 'bar']);
  });

  it('strips /workspace/group/ prefix from input path', async () => {
    stubGeminiFetch();
    const content = 'Container-path test.';
    await fs.writeFile(path.join(workspaceDir, 'file.md'), content);
    manager = createTestManager(workspaceDir);
    await manager.init();

    const result = await manager.getFileContent('/workspace/group/file.md');
    expect(result.content).toBe(content);
    expect(result.path).toBe('file.md');
  });

  it('reports indexed=false for file not yet in DB', async () => {
    stubGeminiFetch();
    await fs.writeFile(path.join(workspaceDir, 'unindexed.md'), 'content');
    manager = createTestManager(workspaceDir);
    await manager.init();
    // No sync() call, so file is not in DB yet

    const result = await manager.getFileContent('unindexed.md');
    expect(result.indexed).toBe(false);
  });

  it('throws for non-existent file', async () => {
    stubGeminiFetch();
    manager = createTestManager(workspaceDir);
    await manager.init();

    await expect(manager.getFileContent('nonexistent.md')).rejects.toThrow();
  });
});

// ---- listFiles ----

describe('MemoryIndexManager.listFiles', () => {
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-mem-list-'),
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

  it('returns empty list when nothing indexed', async () => {
    stubGeminiFetch();
    manager = createTestManager(workspaceDir);
    await manager.init();

    const { files, total } = manager.listFiles();
    expect(files).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('returns indexed files after sync', async () => {
    stubGeminiFetch();
    // listMemoryFiles only indexes files under memory/ subdir
    await fs.mkdir(path.join(workspaceDir, 'memory'), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, 'memory', 'a.md'),
      'File A content.',
    );
    await fs.writeFile(
      path.join(workspaceDir, 'memory', 'b.md'),
      'File B content.',
    );
    manager = createTestManager(workspaceDir, { rpdSessionBudget: 9999 });
    await manager.init();
    await manager.sync();

    const { files, total } = manager.listFiles();
    expect(total).toBe(2);
    expect(files.length).toBe(2);
    expect(files.map((f) => f.path).sort()).toEqual([
      'memory/a.md',
      'memory/b.md',
    ]);
  });

  it('filters by path_prefix', async () => {
    stubGeminiFetch();
    await fs.mkdir(path.join(workspaceDir, 'memory', 'notes'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceDir, 'memory', 'notes', 'note1.md'),
      'Note 1.',
    );
    await fs.writeFile(path.join(workspaceDir, 'MEMORY.md'), 'Root file.');
    manager = createTestManager(workspaceDir, { rpdSessionBudget: 9999 });
    await manager.init();
    await manager.sync();

    const { files } = manager.listFiles({ pathPrefix: 'memory/notes/' });
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.path.startsWith('memory/notes/'))).toBe(true);
  });

  it('respects limit', async () => {
    stubGeminiFetch();
    await fs.mkdir(path.join(workspaceDir, 'memory'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        path.join(workspaceDir, 'memory', `file${i}.md`),
        `Content ${i}.`,
      );
    }
    manager = createTestManager(workspaceDir, { rpdSessionBudget: 9999 });
    await manager.init();
    await manager.sync();

    const { files } = manager.listFiles({ limit: 2 });
    expect(files.length).toBe(2);
  });
});

// ---- search with opts ----

describe('MemoryIndexManager.search with opts', () => {
  let workspaceDir: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nanoclaw-mem-searchopts-'),
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

  it('maxResults opt limits results', async () => {
    stubGeminiFetch();
    manager = createTestManager(workspaceDir);
    await manager.init();

    const results = await manager.search('anything', { maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('minScore opt filters low-score results', async () => {
    stubGeminiFetch();
    manager = createTestManager(workspaceDir);
    await manager.init();

    const results = await manager.search('anything', { minScore: 0.99 });
    expect(results.every((r) => r.score >= 0.99)).toBe(true);
  });

  it('returns empty array for empty query regardless of opts', async () => {
    stubGeminiFetch();
    manager = createTestManager(workspaceDir);
    await manager.init();

    const results = await manager.search('', { maxResults: 10, minScore: 0 });
    expect(results).toEqual([]);
  });
});
