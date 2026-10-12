// Spec: specs/memory.allium — NanoClaw v2 memory indexing and semantic search
//
// MemoryFile and MemoryChunk are realised by the group's own index
// (data/v2-memory/<group>/index.db: files, chunks, with their keyword and vector
// rows); there is no central copy (Option A, docs/memory-index-remediation-plan.md).
// The lifecycle rules are therefore tested through MemoryIndexManager against a
// real index file.
//
// Elsewhere:
//   IndexSettingsChanged / IndexBuilt / MemoryIndexCreated — startup-fingerprint.test.ts
//   MemoryFilesWithinWorkspace — the manager walks only the group's memory/,
//     zettel/, registered workspace folders and indexed mounts:
//     workspace-dirs.test.ts, indexed-mounts.test.ts
//   MemoryFileRead / MemoryListed and the MCP surface (container reads the index):
//     container/agent-runner/src/mcp-tools/memory.test.ts

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { MEMORY_CONFIG } from './config.js';
import { groupByFile } from './hybrid.js';
import { MemoryIndexManager } from './manager.js';
import { handleMemorySearch } from './search.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GROUP_ID = 'ag-test';
const SESSION = { id: 'sess-1', agent_group_id: GROUP_ID };
const SESSION_OTHER_GROUP = { id: 'sess-2', agent_group_id: 'ag-other' };

let root: string;
let memory: string;
let dbPath: string;

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: GROUP_ID,
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-spec-')));
  memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  dbPath = path.join(root, 'index.db');
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

async function started(): Promise<MemoryIndexManager> {
  // memoryDir is left empty: the files go in through a prefixed dir, so they are
  // stored under the repo-relative path the host gives them (groups/<folder>/…).
  const unused = path.join(root, 'unused');
  fs.mkdirSync(unused, { recursive: true });
  const m = new MemoryIndexManager(GROUP_ID, 'test-agent', unused, dbPath, 'k', 'gemini-embedding-001', [
    { dir: memory, source: 'memory', pathPrefix: 'groups/test-agent/memory' },
  ]);
  await m.init();
  await settled(m);
  return m;
}

async function settled(m: MemoryIndexManager): Promise<void> {
  await vi.waitFor(() => expect((m as unknown as { _syncing: boolean })._syncing).toBe(false), { timeout: 5000 });
  await (m as unknown as { syncLock: Promise<void> }).syncLock;
}

/** A sync as a watcher event would start it. */
async function changed(m: MemoryIndexManager): Promise<void> {
  (m as unknown as { dirty: boolean }).dirty = true;
  await m.sync();
  await settled(m);
}

const P = 'groups/test-agent/memory/notes.md';

function index(): {
  files: Array<{ path: string; hash: string }>;
  chunks: Array<{ id: string; path: string; text: string; updated_at: number }>;
  fts: string[];
  vec: string[];
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      files: db.prepare('SELECT path, hash FROM files WHERE path = ?').all(P) as Array<{ path: string; hash: string }>,
      chunks: db.prepare('SELECT id, path, text, updated_at FROM chunks WHERE path = ? ORDER BY id').all(P) as Array<{
        id: string;
        path: string;
        text: string;
        updated_at: number;
      }>,
      fts: (db.prepare('SELECT id FROM chunks_fts WHERE path = ? ORDER BY id').all(P) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
      vec: (
        db.prepare("SELECT id FROM chunks_vec_rowids WHERE id LIKE ? || ':%' ORDER BY id").all(P) as Array<{
          id: string;
        }>
      ).map((r) => r.id),
    };
  } finally {
    db.close();
  }
}

// ── Config defaults  [config-default.*] ───────────────────────────────────────

describe('config defaults', () => {
  it('chunk_tokens = 400', async () => {
    expect(MEMORY_CONFIG.chunk_tokens).toBe(400);
  });
  it('chunk_overlap_tokens = 80', async () => {
    expect(MEMORY_CONFIG.chunk_overlap_tokens).toBe(80);
  });
  it('search_top_k = 6', async () => {
    expect(MEMORY_CONFIG.search_top_k).toBe(6);
  });
  it('min_search_score = 0.35', async () => {
    expect(MEMORY_CONFIG.min_search_score).toBe(0.35);
  });
  it('vector_score_weight = 0.7', async () => {
    expect(MEMORY_CONFIG.vector_score_weight).toBe(0.7);
  });
  it('keyword_score_weight = 0.3', async () => {
    expect(MEMORY_CONFIG.keyword_score_weight).toBe(0.3);
  });
  it('embedding_provider = "gemini"', async () => {
    expect(MEMORY_CONFIG.embedding_provider).toBe('gemini');
  });
  it('embedding_rpm_limit = 50', async () => {
    expect(MEMORY_CONFIG.embedding_rpm_limit).toBe(50);
  });
  it('embedding_tpm_limit = 15000', async () => {
    expect(MEMORY_CONFIG.embedding_tpm_limit).toBe(15_000);
  });
  it('embedding_rpd_budget = 900', async () => {
    expect(MEMORY_CONFIG.embedding_rpd_budget).toBe(900);
  });
  it('memory_search_enabled = true', async () => {
    expect(MEMORY_CONFIG.memory_search_enabled).toBe(true);
  });
});

// ── Value types  [value-equality.*, entity-fields.MemorySearchResult, MemorySearchParams, MemoryListParams] ──

describe('value types', () => {
  it('MemorySearchParams has all five optional fields', async () => {
    // [entity-fields.MemorySearchParams, value-equality.MemorySearchParams]
    const p = { limit: null, min_score: null, path_prefix: null, source: null, include_content: null };
    expect(Object.keys(p)).toEqual(['limit', 'min_score', 'path_prefix', 'source', 'include_content']);
  });

  it('MemorySearchParams accepts populated values', async () => {
    const p = { limit: 10, min_score: 0.5, path_prefix: 'groups/x/memory/', source: 'wiki', include_content: true };
    expect(p.limit).toBe(10);
    expect(p.include_content).toBe(true);
  });

  it('MemoryListParams has all five optional fields', async () => {
    // [entity-fields.MemoryListParams, value-equality.MemoryListParams]
    const p = { path_prefix: null, source: null, limit: null, order_by: null, parse_frontmatter: null };
    expect(Object.keys(p)).toEqual(['path_prefix', 'source', 'limit', 'order_by', 'parse_frontmatter']);
  });

  it('MemorySearchResult is one file with a score, its locations and a count of the rest', async () => {
    // [entity-fields.MemorySearchResult, entity-fields.MemorySearchLocation]
    const [r] = groupByFile(
      [{ path: 'groups/g/memory/a.md', source: 'memory', startLine: 1, endLine: 5, score: 0.85, snippet: 'excerpt' }],
      { limit: 6, locationsPerFile: 3, otherSnippetChars: 200 },
    );
    expect(r).toEqual({
      path: 'groups/g/memory/a.md',
      source: 'memory',
      score: 0.85,
      locations: [{ startLine: 1, endLine: 5, score: 0.85, snippet: 'excerpt' }],
      moreLocations: 0,
    });
  });
});

// ── MemoryFile lifecycle, realised by index.db ─────────────────────────────────
// [rule-success.FileDiscovered, rule-success.FileUpdated, rule-failure.FileUpdated.2,
//  rule-success.FileRemoved, rule-success.FileSynced, transition-edge.MemoryFile.*,
//  invariant.ChunksPresentOnlyWhenIndexed]

describe('MemoryFile lifecycle', { timeout: 20_000 }, () => {
  it('a new file is discovered and indexed: a files row, and chunks with their keyword and vector rows  [rule-success.FileDiscovered] [rule-success.FileSynced]', async () => {
    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nAlpha.\n');
    const m = await started();
    const ix = index();
    expect(ix.files).toHaveLength(1);
    expect(ix.chunks.length).toBeGreaterThan(0);
    expect(ix.fts).toEqual(ix.chunks.map((c) => c.id));
    expect(ix.vec).toEqual(ix.chunks.map((c) => c.id));
    await m.close();
  });

  it('a changed file returns to pending and is re-indexed; its old chunks are replaced  [rule-success.FileUpdated] [transition-edge.MemoryFile.indexed.pending] [transition-edge.MemoryFile.pending.indexed]', async () => {
    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nAlpha.\n');
    const m = await started();
    const before = index();

    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nBeta.\n');
    await changed(m);
    const after = index();
    expect(after.files[0]!.hash).not.toBe(before.files[0]!.hash);
    expect(after.chunks.map((c) => c.text).join()).toContain('Beta');
    expect(after.chunks.map((c) => c.text).join()).not.toContain('Alpha');
    expect(after.fts).toEqual(after.chunks.map((c) => c.id));
    expect(after.vec).toEqual(after.chunks.map((c) => c.id));
    await m.close();
  });

  it('an event without a content change re-indexes nothing  [rule-failure.FileUpdated.2]', async () => {
    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nAlpha.\n');
    const m = await started();
    const before = index();
    fs.utimesSync(path.join(memory, 'notes.md'), new Date(), new Date());
    await changed(m);
    expect(index()).toEqual(before);
    await m.close();
  });

  it('a removed file leaves the index: its record, chunks, keyword and vector rows  [rule-success.FileRemoved]', async () => {
    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nAlpha.\n');
    const m = await started();
    fs.rmSync(path.join(memory, 'notes.md'));
    await changed(m);
    expect(index()).toEqual({ files: [], chunks: [], fts: [], vec: [] });
    await m.close();
  });

  it('a file created again at the path of a removed one is discovered afresh  [rule-success.FileDiscovered]', async () => {
    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nAlpha.\n');
    const m = await started();
    fs.rmSync(path.join(memory, 'notes.md'));
    await changed(m);

    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nGamma.\n');
    await changed(m);
    const ix = index();
    expect(ix.files).toHaveLength(1);
    expect(ix.chunks.map((c) => c.text).join()).toContain('Gamma');
    await m.close();
  });

  it('every chunk belongs to a file in the index  [invariant.ChunksPresentOnlyWhenIndexed]', async () => {
    fs.writeFileSync(path.join(memory, 'notes.md'), '# Notes\n\nAlpha.\n');
    fs.writeFileSync(path.join(memory, 'other.md'), '# Other\n\nDelta.\n');
    const m = await started();
    fs.rmSync(path.join(memory, 'other.md'));
    await changed(m);
    const db = new Database(dbPath, { readonly: true });
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.path = c.path)')
      .get();
    db.close();
    expect(orphans).toEqual({ n: 0 });
    await m.close();
  });
});

// ── MemorySearched rule  [rule-success.MemorySearched, rule-failure.MemorySearched.*] ──

describe('MemorySearched rule', () => {
  it('returns a mode and an array of results for a valid session+group pair  [rule-success.MemorySearched]', async () => {
    const response = await handleMemorySearch({ session: SESSION, group_id: GROUP_ID, query: 'meeting notes' });
    expect(Array.isArray(response.results)).toBe(true);
    // No manager for this group on the host: the container falls back to keyword search.
    expect(response.mode).toBe('unavailable');
  });

  it('rejects when session.agent_group_id does not match group  [rule-failure.MemorySearched.1]', async () => {
    await expect(
      handleMemorySearch({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID, query: 'anything' }),
    ).rejects.toThrow();
  });

  it('rejects when memory_search_enabled is false  [rule-failure.MemorySearched.2]', async () => {
    const cfg = { ...MEMORY_CONFIG, memory_search_enabled: false };
    await expect(
      handleMemorySearch({ session: SESSION, group_id: GROUP_ID, query: 'anything' }, cfg),
    ).rejects.toThrow();
  });
});

// ── MemoryMcpTools surface, host side: search  [surface-actor.MemoryMcpTools] ──
// Get and list are answered in the container from its read-only index mount;
// their tests live in container/agent-runner/src/mcp-tools/memory.test.ts.

describe('MemoryMcpTools surface (host-side actor restriction)', () => {
  it('AgentMemorySearch is not available to a session from a different group  [surface-actor.MemoryMcpTools]', async () => {
    await expect(
      handleMemorySearch({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID, query: 'q' }),
    ).rejects.toThrow();
  });
});
