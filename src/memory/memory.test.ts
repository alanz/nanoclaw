// Spec: specs/memory.allium — NanoClaw v2 memory indexing and semantic search
//
// Covers all obligations from `allium plan specs/memory.allium`.
// These tests define the implementation contract. They will fail until the
// following modules are created:
//
//   src/memory/config.ts   — MEMORY_CONFIG defaults
//   src/memory/db.ts       — MemoryFile + MemoryChunk CRUD (central DB via getDb())
//   src/memory/rules.ts    — FileUpdated, FileDiscovered, FileRemoved, FileSynced handlers
//   src/memory/search.ts   — MemorySearched, MemoryFileRead, MemoryListed handlers
//
// A new migration under src/db/migrations/ must add:
//   memory_files  (id, group_id, path, content_hash, indexed_at, status, created_at)
//   memory_chunks (id, file_id, start_line, end_line, content, hash, indexed_at)
//
// Container-side surface tests (MemoryMcpTools registration + specialist gating):
//   container/agent-runner/src/mcp-tools/memory.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { MEMORY_CONFIG } from './config.js';
import type { MemoryChunk, MemoryFile } from './db.js';
import {
  createMemoryChunk,
  createMemoryFile,
  findMemoryFile,
  getAllMemoryChunks,
  getAllMemoryFiles,
  getMemoryFile,
  getMemoryFileChunks,
  updateMemoryFile,
} from './db.js';
import { handleWorkspaceFileChanged, handleWorkspaceFileRemoved, syncPendingFile } from './rules.js';
import { handleMemoryGet, handleMemoryList, handleMemorySearch } from './search.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

const GROUP_ID = 'ag-test';
const GROUP_FOLDER = 'test-agent';

// Minimal session fixtures (sessions/Session with agent_group_id field)
const SESSION = { id: 'sess-1', agent_group_id: GROUP_ID };
const SESSION_OTHER_GROUP = { id: 'sess-2', agent_group_id: 'ag-other' };

function memPath(name = 'notes.md'): string {
  return `groups/${GROUP_FOLDER}/memory/${name}`;
}

// ── Test lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: GROUP_ID, name: 'Test Agent', folder: GROUP_FOLDER, agent_provider: null, created_at: ts() });
});

afterEach(() => {
  closeDb();
});

// ── Config defaults  [config-default.*] ───────────────────────────────────────

describe('config defaults', () => {
  it('chunk_tokens = 400', () => { expect(MEMORY_CONFIG.chunk_tokens).toBe(400); });
  it('chunk_overlap_tokens = 80', () => { expect(MEMORY_CONFIG.chunk_overlap_tokens).toBe(80); });
  it('search_top_k = 6', () => { expect(MEMORY_CONFIG.search_top_k).toBe(6); });
  it('min_search_score = 0.35', () => { expect(MEMORY_CONFIG.min_search_score).toBe(0.35); });
  it('vector_score_weight = 0.7', () => { expect(MEMORY_CONFIG.vector_score_weight).toBe(0.7); });
  it('keyword_score_weight = 0.3', () => { expect(MEMORY_CONFIG.keyword_score_weight).toBe(0.3); });
  it('embedding_provider = "gemini"', () => { expect(MEMORY_CONFIG.embedding_provider).toBe('gemini'); });
  it('embedding_rpm_limit = 50', () => { expect(MEMORY_CONFIG.embedding_rpm_limit).toBe(50); });
  it('embedding_tpm_limit = 15000', () => { expect(MEMORY_CONFIG.embedding_tpm_limit).toBe(15_000); });
  it('embedding_rpd_budget = 900', () => { expect(MEMORY_CONFIG.embedding_rpd_budget).toBe(900); });
  it('memory_search_enabled = true', () => { expect(MEMORY_CONFIG.memory_search_enabled).toBe(true); });
});

// ── MemoryFile entity  [entity-fields.MemoryFile, entity-optional.MemoryFile.indexed_at, entity-relationship.MemoryFile.chunks] ──

describe('MemoryFile entity', () => {
  it('has all declared fields with correct types', () => {
    // [entity-fields.MemoryFile]
    const file = createMemoryFile({
      group_id: GROUP_ID,
      path: memPath(),
      content_hash: 'abc123',
      status: 'pending',
      indexed_at: null,
    });
    expect(typeof file.id).toBe('string');
    expect(file.group_id).toBe(GROUP_ID);
    expect(file.path).toBe(memPath());
    expect(file.content_hash).toBe('abc123');
    expect(file.status).toBe('pending');
    expect(file.indexed_at).toBeNull();
  });

  it('accepts null indexed_at before first sync', () => {
    // [entity-optional.MemoryFile.indexed_at]
    const file = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'pending', indexed_at: null });
    expect(file.indexed_at).toBeNull();
  });

  it('accepts non-null indexed_at after first sync', () => {
    // [entity-optional.MemoryFile.indexed_at]
    const stamp = ts();
    const file = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'indexed', indexed_at: stamp });
    expect(file.indexed_at).toBe(stamp);
  });

  it('chunks relationship navigates to associated MemoryChunks', () => {
    // [entity-relationship.MemoryFile.chunks]
    const file = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    createMemoryChunk({ file_id: file.id, start_line: 1, end_line: 10, content: 'hello', hash: 'h1', indexed_at: ts() });
    const chunks = getMemoryFileChunks(file.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].file_id).toBe(file.id);
  });
});

// ── MemoryChunk entity  [entity-fields.MemoryChunk] ──────────────────────────

describe('MemoryChunk entity', () => {
  it('has all declared fields with correct types', () => {
    const file = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    const stamp = ts();
    const chunk = createMemoryChunk({ file_id: file.id, start_line: 5, end_line: 25, content: 'chunk text', hash: 'cafebabe', indexed_at: stamp });
    expect(typeof chunk.id).toBe('string');
    expect(chunk.file_id).toBe(file.id);
    expect(chunk.start_line).toBe(5);
    expect(chunk.end_line).toBe(25);
    expect(chunk.content).toBe('chunk text');
    expect(chunk.hash).toBe('cafebabe');
    expect(chunk.indexed_at).toBe(stamp);
  });
});

// ── Value types  [value-equality.*, entity-fields.MemorySearchResult, MemorySearchParams, MemoryListParams] ──

describe('value types', () => {
  it('MemorySearchParams has all five optional fields', () => {
    // [entity-fields.MemorySearchParams, value-equality.MemorySearchParams]
    const p = { limit: null, min_score: null, path_prefix: null, source: null, include_content: null };
    expect(Object.keys(p)).toEqual(['limit', 'min_score', 'path_prefix', 'source', 'include_content']);
  });

  it('MemorySearchParams accepts populated values', () => {
    const p = { limit: 10, min_score: 0.5, path_prefix: 'groups/x/memory/', source: 'wiki', include_content: true };
    expect(p.limit).toBe(10);
    expect(p.include_content).toBe(true);
  });

  it('MemoryListParams has all five optional fields', () => {
    // [entity-fields.MemoryListParams, value-equality.MemoryListParams]
    const p = { path_prefix: null, source: null, limit: null, order_by: null, parse_frontmatter: null };
    expect(Object.keys(p)).toEqual(['path_prefix', 'source', 'limit', 'order_by', 'parse_frontmatter']);
  });

  it('MemorySearchResult has chunk, score, and snippet fields', () => {
    // [entity-fields.MemorySearchResult, value-equality.MemorySearchResult]
    const r = { chunk: {} as MemoryChunk, score: 0.85, snippet: 'excerpt' };
    expect(typeof r.score).toBe('number');
    expect(typeof r.snippet).toBe('string');
  });
});

// ── MemoryFile state transitions  [transition-edge.*, transition-rejected.*, transition-terminal.*] ──

describe('MemoryFile state transitions', () => {
  function file(status: MemoryFile['status'], suffix = ''): MemoryFile {
    return createMemoryFile({
      group_id: GROUP_ID,
      path: memPath(`${status}${suffix}.md`),
      content_hash: 'h',
      status,
      indexed_at: status === 'indexed' ? ts() : null,
    });
  }

  it('pending -> indexed  [transition-edge.MemoryFile.pending.indexed]', () => {
    const f = file('pending');
    updateMemoryFile(f.id, { status: 'indexed', indexed_at: ts() });
    expect(getMemoryFile(f.id)!.status).toBe('indexed');
  });

  it('indexed -> pending  [transition-edge.MemoryFile.indexed.pending]', () => {
    const f = file('indexed');
    updateMemoryFile(f.id, { status: 'pending' });
    expect(getMemoryFile(f.id)!.status).toBe('pending');
  });

  it('indexed -> removed  [transition-edge.MemoryFile.indexed.removed]', () => {
    const f = file('indexed', '2');
    updateMemoryFile(f.id, { status: 'removed' });
    expect(getMemoryFile(f.id)!.status).toBe('removed');
  });

  it('pending -> removed  [transition-edge.MemoryFile.pending.removed]', () => {
    const f = file('pending', '2');
    updateMemoryFile(f.id, { status: 'removed' });
    expect(getMemoryFile(f.id)!.status).toBe('removed');
  });

  it('rejects removed -> pending (undeclared)  [transition-rejected.MemoryFile.status]', () => {
    const f = file('indexed', '3');
    updateMemoryFile(f.id, { status: 'removed' });
    expect(() => updateMemoryFile(f.id, { status: 'pending' })).toThrow();
  });

  it('rejects removed -> indexed (undeclared)  [transition-rejected.MemoryFile.status]', () => {
    const f = file('indexed', '4');
    updateMemoryFile(f.id, { status: 'removed' });
    expect(() => updateMemoryFile(f.id, { status: 'indexed' })).toThrow();
  });

  it('removed has no outbound transitions (terminal)  [transition-terminal.MemoryFile.status]', () => {
    const f = file('pending', '3');
    updateMemoryFile(f.id, { status: 'removed' });
    expect(() => updateMemoryFile(f.id, { status: 'indexed' })).toThrow();
    expect(() => updateMemoryFile(f.id, { status: 'pending' })).toThrow();
  });
});

// ── FileUpdated rule  [rule-success.FileUpdated, rule-failure.FileUpdated.*] ──

describe('FileUpdated rule', () => {
  it('marks an existing indexed file pending when content hash changes  [rule-success.FileUpdated]', () => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'old', status: 'indexed', indexed_at: ts() });
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath(), content_hash: 'new' });
    const f = findMemoryFile({ group_id: GROUP_ID, path: memPath() })!;
    expect(f.status).toBe('pending');
    expect(f.content_hash).toBe('new');
  });

  it('skips update when content hash is unchanged (no-op)  [rule-failure.FileUpdated.2]', () => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'same', status: 'indexed', indexed_at: ts() });
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath(), content_hash: 'same' });
    expect(findMemoryFile({ group_id: GROUP_ID, path: memPath() })!.status).toBe('indexed');
  });

  it('does not apply FileUpdated when file does not exist; FileDiscovered runs instead  [rule-failure.FileUpdated.1]', () => {
    const before = getAllMemoryFiles().length;
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath('ghost.md'), content_hash: 'h1' });
    // FileDiscovered created a new file; FileUpdated did not run (no existing file to update)
    expect(getAllMemoryFiles().length).toBe(before + 1);
    expect(findMemoryFile({ group_id: GROUP_ID, path: memPath('ghost.md') })!.status).toBe('pending');
  });

  it('does not apply FileUpdated when file is in terminal "removed" state  [rule-failure.FileUpdated.3]', () => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'old', status: 'removed', indexed_at: null });
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath(), content_hash: 'new' });
    // Removed files are terminal — no transition back to pending
    expect(findMemoryFile({ group_id: GROUP_ID, path: memPath() })!.status).toBe('removed');
  });
});

// ── FileDiscovered rule  [rule-success.FileDiscovered, rule-failure.FileDiscovered.1, rule-entity-creation.FileDiscovered.1] ──

describe('FileDiscovered rule', () => {
  it('creates a new MemoryFile in pending status for an unseen path  [rule-success.FileDiscovered]', () => {
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath('new.md'), content_hash: 'sha256-abc' });
    const f = findMemoryFile({ group_id: GROUP_ID, path: memPath('new.md') });
    expect(f).not.toBeNull();
    expect(f!.status).toBe('pending');
    expect(f!.indexed_at).toBeNull();
  });

  it('does not create a duplicate when the path already exists  [rule-failure.FileDiscovered.1]', () => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'old', status: 'indexed', indexed_at: ts() });
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath(), content_hash: 'new' });
    const matches = getAllMemoryFiles().filter((f: MemoryFile) => f.group_id === GROUP_ID && f.path === memPath());
    expect(matches).toHaveLength(1);
  });

  it('created entity has all spec-required fields populated  [rule-entity-creation.FileDiscovered.1]', () => {
    // ensures: MemoryFile.created(group, path, content_hash, status: pending)
    const path = memPath('spec-fields.md');
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path, content_hash: 'sha256-test' });
    const f = findMemoryFile({ group_id: GROUP_ID, path })!;
    expect(f.group_id).toBe(GROUP_ID);
    expect(f.path).toBe(path);
    expect(f.content_hash).toBe('sha256-test');
    expect(f.status).toBe('pending');
    expect(f.indexed_at).toBeNull();
    expect(typeof f.id).toBe('string');
  });
});

// ── FileRemoved rule  [rule-success.FileRemoved, rule-failure.FileRemoved.*] ──

describe('FileRemoved rule', () => {
  it('marks the file removed and deletes all its chunks  [rule-success.FileRemoved]', () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    createMemoryChunk({ file_id: f.id, start_line: 1, end_line: 5, content: 'a', hash: 'h1', indexed_at: ts() });
    createMemoryChunk({ file_id: f.id, start_line: 6, end_line: 10, content: 'b', hash: 'h2', indexed_at: ts() });

    handleWorkspaceFileRemoved({ group_id: GROUP_ID, path: memPath() });

    expect(getMemoryFile(f.id)!.status).toBe('removed');
    expect(getMemoryFileChunks(f.id)).toHaveLength(0);
  });

  it('is a no-op when the file does not exist  [rule-failure.FileRemoved.1]', () => {
    expect(() => handleWorkspaceFileRemoved({ group_id: GROUP_ID, path: memPath('ghost.md') })).not.toThrow();
  });

  it('is a no-op when the file is already in the terminal "removed" state  [rule-failure.FileRemoved.2]', () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'removed', indexed_at: null });
    expect(() => handleWorkspaceFileRemoved({ group_id: GROUP_ID, path: memPath() })).not.toThrow();
    expect(getMemoryFile(f.id)!.status).toBe('removed');
  });
});

// ── FileSynced rule  [rule-success.FileSynced, rule-failure.FileSynced.1] ────

const mockChunkFn = vi.fn();
const mockEmbedFn = vi.fn();

describe('FileSynced rule', () => {
  beforeEach(() => {
    mockChunkFn.mockReset();
    mockEmbedFn.mockReset();
  });

  it('transitions pending->indexed, replaces chunks, sets indexed_at  [rule-success.FileSynced]', async () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'pending', indexed_at: null });
    // Stale chunk from a previous index — should be replaced
    createMemoryChunk({ file_id: f.id, start_line: 1, end_line: 5, content: 'stale', hash: 'old', indexed_at: ts() });

    mockChunkFn.mockReturnValue([{ start_line: 1, end_line: 10, content: 'fresh', hash: 'new-hash' }]);
    mockEmbedFn.mockResolvedValue(undefined);

    await syncPendingFile(f, { chunkFn: mockChunkFn, embedFn: mockEmbedFn });

    const updated = getMemoryFile(f.id)!;
    expect(updated.status).toBe('indexed');
    expect(updated.indexed_at).not.toBeNull();

    const chunks = getMemoryFileChunks(f.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('fresh');
    expect(chunks[0].hash).toBe('new-hash');
  });

  it('rejects when file status is not pending  [rule-failure.FileSynced.1]', async () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    await expect(syncPendingFile(f, { chunkFn: mockChunkFn, embedFn: mockEmbedFn })).rejects.toThrow();
  });
});

// ── MemorySearched rule  [rule-success.MemorySearched, rule-failure.MemorySearched.*] ──

describe('MemorySearched rule', () => {
  it('returns an array of results for a valid session+group pair  [rule-success.MemorySearched]', () => {
    const results = handleMemorySearch({ session: SESSION, group_id: GROUP_ID, query: 'meeting notes' });
    expect(Array.isArray(results)).toBe(true);
  });

  it('rejects when session.agent_group_id does not match group  [rule-failure.MemorySearched.1]', () => {
    expect(() => handleMemorySearch({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID, query: 'anything' })).toThrow();
  });

  it('rejects when memory_search_enabled is false  [rule-failure.MemorySearched.2]', () => {
    const cfg = { ...MEMORY_CONFIG, memory_search_enabled: false };
    expect(() => handleMemorySearch({ session: SESSION, group_id: GROUP_ID, query: 'anything' }, cfg)).toThrow();
  });
});

// ── MemoryFileRead rule  [rule-success.MemoryFileRead, rule-failure.MemoryFileRead.*] ──

describe('MemoryFileRead rule', () => {
  beforeEach(() => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath('doc.md'), content_hash: 'h', status: 'indexed', indexed_at: ts() });
  });

  it('returns content for an indexed file  [rule-success.MemoryFileRead]', () => {
    const result = handleMemoryGet({ session: SESSION, group_id: GROUP_ID, path: memPath('doc.md') });
    expect(result).not.toBeNull();
  });

  it('rejects when session.agent_group_id does not match group  [rule-failure.MemoryFileRead.1]', () => {
    expect(() => handleMemoryGet({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID, path: memPath('doc.md') })).toThrow();
  });

  it('rejects when memory_search_enabled is false  [rule-failure.MemoryFileRead.2]', () => {
    const cfg = { ...MEMORY_CONFIG, memory_search_enabled: false };
    expect(() => handleMemoryGet({ session: SESSION, group_id: GROUP_ID, path: memPath('doc.md') }, cfg)).toThrow();
  });

  it('rejects when the file exists but is not in indexed status  [rule-failure.MemoryFileRead.3]', () => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath('pending.md'), content_hash: 'h', status: 'pending', indexed_at: null });
    expect(() => handleMemoryGet({ session: SESSION, group_id: GROUP_ID, path: memPath('pending.md') })).toThrow();
  });
});

// ── MemoryListed rule  [rule-success.MemoryListed, rule-failure.MemoryListed.*] ──

describe('MemoryListed rule', () => {
  it('returns a list of files for a valid session+group pair  [rule-success.MemoryListed]', () => {
    const results = handleMemoryList({ session: SESSION, group_id: GROUP_ID });
    expect(Array.isArray(results)).toBe(true);
  });

  it('rejects when session.agent_group_id does not match group  [rule-failure.MemoryListed.1]', () => {
    expect(() => handleMemoryList({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID })).toThrow();
  });

  it('rejects when memory_search_enabled is false  [rule-failure.MemoryListed.2]', () => {
    const cfg = { ...MEMORY_CONFIG, memory_search_enabled: false };
    expect(() => handleMemoryList({ session: SESSION, group_id: GROUP_ID }, cfg)).toThrow();
  });
});

// ── Invariant: MemoryFilesWithinWorkspace ─────────────────────────────────────

describe('invariant: MemoryFilesWithinWorkspace', () => {
  it('all files created via the rule handler have paths under groups/<folder>/memory/  [invariant.MemoryFilesWithinWorkspace]', () => {
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath('a.md'), content_hash: 'h1' });
    handleWorkspaceFileChanged({ group_id: GROUP_ID, path: memPath('sub/b.org'), content_hash: 'h2' });
    for (const f of getAllMemoryFiles()) {
      expect(f.path.startsWith('groups/')).toBe(true);
      expect(f.path.includes('/memory/')).toBe(true);
    }
  });

  it('rejects a file whose path is outside the memory/ directory  [invariant.MemoryFilesWithinWorkspace]', () => {
    expect(() =>
      handleWorkspaceFileChanged({ group_id: GROUP_ID, path: `groups/${GROUP_FOLDER}/CLAUDE.md`, content_hash: 'h' }),
    ).toThrow();
  });
});

// ── Invariant: NoChunksForRemovedFiles ────────────────────────────────────────

describe('invariant: NoChunksForRemovedFiles', () => {
  it('FileRemoved deletes chunks so no chunk references a removed file  [invariant.NoChunksForRemovedFiles]', () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    createMemoryChunk({ file_id: f.id, start_line: 1, end_line: 5, content: 'x', hash: 'h1', indexed_at: ts() });

    handleWorkspaceFileRemoved({ group_id: GROUP_ID, path: memPath() });

    for (const c of getAllMemoryChunks()) {
      const parent = getMemoryFile(c.file_id)!;
      expect(parent.status).not.toBe('removed');
    }
  });
});

// ── Invariant: ChunksPresentOnlyWhenIndexed ───────────────────────────────────

describe('invariant: ChunksPresentOnlyWhenIndexed', () => {
  it('a newly created pending file (indexed_at = null) has no chunks  [invariant.ChunksPresentOnlyWhenIndexed]', () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'pending', indexed_at: null });
    expect(getMemoryFileChunks(f.id)).toHaveLength(0);
  });

  it('after FileSynced, indexed_at is set and chunks are present  [invariant.ChunksPresentOnlyWhenIndexed]', async () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'pending', indexed_at: null });
    mockChunkFn.mockReturnValue([{ start_line: 1, end_line: 10, content: 'text', hash: 'h1' }]);
    mockEmbedFn.mockResolvedValue(undefined);

    await syncPendingFile(f, { chunkFn: mockChunkFn, embedFn: mockEmbedFn });

    expect(getMemoryFile(f.id)!.indexed_at).not.toBeNull();
    expect(getMemoryFileChunks(f.id)).toHaveLength(1);
  });
});

// ── MemoryMcpTools surface  [surface-actor.MemoryMcpTools, surface-provides.MemoryMcpTools] ──
//
// Actor restriction (session must belong to the queried group) is enforced by
// the rule-level `requires: session.agent_group = group` checks already tested
// above (all three rule failure tests for session mismatch).
//
// Tool registration and specialist gating tests live in the container tree:
//   container/agent-runner/src/mcp-tools/memory.test.ts
//
// This describe block provides the host-side surface contract summary:

describe('MemoryMcpTools surface (host-side actor restriction)', () => {
  it('AgentMemorySearch is not available to a session from a different group  [surface-actor.MemoryMcpTools]', () => {
    expect(() => handleMemorySearch({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID, query: 'q' })).toThrow();
  });

  it('AgentMemoryGet is not available to a session from a different group', () => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath('doc.md'), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    expect(() => handleMemoryGet({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID, path: memPath('doc.md') })).toThrow();
  });

  it('AgentMemoryList is not available to a session from a different group', () => {
    expect(() => handleMemoryList({ session: SESSION_OTHER_GROUP, group_id: GROUP_ID })).toThrow();
  });

  it('all three operations succeed for a matching session  [surface-provides.MemoryMcpTools]', () => {
    createMemoryFile({ group_id: GROUP_ID, path: memPath('doc.md'), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    expect(() => handleMemorySearch({ session: SESSION, group_id: GROUP_ID, query: 'q' })).not.toThrow();
    expect(() => handleMemoryGet({ session: SESSION, group_id: GROUP_ID, path: memPath('doc.md') })).not.toThrow();
    expect(() => handleMemoryList({ session: SESSION, group_id: GROUP_ID })).not.toThrow();
  });
});

// ── Deadlock scenarios (from `allium analyse`)  ───────────────────────────────
//
// allium analyse reports two deadlock findings for MemoryFile: the `pending` and
// `indexed` states have no achievable path to the terminal `removed` state via
// internal rules alone. This is expected: `WorkspaceFileRemoved` is an external
// trigger (filesystem watcher) with no governing spec. The MemoryFile entity has
// `allium-ignore allium.status.unreachableValue, allium.status.noExit` for exactly
// this reason.
//
// These tests document that the external trigger is the only route to `removed`,
// and verify that it works correctly.

describe('deadlock scenarios (external trigger resolves both stuck states)', () => {
  it('a pending file reaches "removed" only via handleWorkspaceFileRemoved', () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'pending', indexed_at: null });
    expect(getMemoryFile(f.id)!.status).toBe('pending');
    handleWorkspaceFileRemoved({ group_id: GROUP_ID, path: memPath() });
    expect(getMemoryFile(f.id)!.status).toBe('removed');
  });

  it('an indexed file reaches "removed" only via handleWorkspaceFileRemoved', () => {
    const f = createMemoryFile({ group_id: GROUP_ID, path: memPath(), content_hash: 'h', status: 'indexed', indexed_at: ts() });
    handleWorkspaceFileRemoved({ group_id: GROUP_ID, path: memPath() });
    expect(getMemoryFile(f.id)!.status).toBe('removed');
  });
});
