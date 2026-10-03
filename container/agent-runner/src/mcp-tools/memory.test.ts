// Spec: specs/memory.allium — surface MemoryMcpTools
// Obligations: surface-provides.MemoryMcpTools, surface-actor.MemoryMcpTools
//
// Verifies that the three memory MCP tool definitions are exported with the
// correct names, and that specialist containers exclude them.
//
// TODO: create container/agent-runner/src/mcp-tools/memory.ts with tool definitions
// for memory_search, memory_get_file_content, and memory_list_files. Gate
// the `registerTools([...])` call on `!isSpecialist` so specialist containers
// do not receive these tools (spec guidance on MemorySearched, MemoryFileRead,
// MemoryListed).

import { describe, expect, it } from 'bun:test';

// TODO: export individual tool definitions from memory.ts so tests can inspect them
import { memoryGetFileContent, memoryListFiles, memorySearch, resolveIndexedPath } from './memory.js';

const EXPECTED_TOOL_NAMES = ['memory_search', 'memory_get_file_content', 'memory_list_files'] as const;

// ── surface-provides.MemoryMcpTools ──────────────────────────────────────────

describe('MemoryMcpTools — tool names match surface provides', () => {
  it('memory_search tool is declared with the correct name', () => {
    expect(memorySearch.tool.name).toBe('memory_search');
  });

  it('memory_get_file_content tool is declared with the correct name', () => {
    expect(memoryGetFileContent.tool.name).toBe('memory_get_file_content');
  });

  it('memory_list_files tool is declared with the correct name', () => {
    expect(memoryListFiles.tool.name).toBe('memory_list_files');
  });

  it('all three surface operations are present', () => {
    const names = [memorySearch.tool.name, memoryGetFileContent.tool.name, memoryListFiles.tool.name];
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });
});

// ── Tool input schemas ────────────────────────────────────────────────────────

describe('MemoryMcpTools — tool input schemas', () => {
  // The `group` param was dropped (see "drop group param from MCP tools"): each
  // session is already scoped to its own agent group, which the host resolves,
  // so the tools never take a group argument.
  it('memory_search accepts query and optional top_k / path_prefix, no group', () => {
    const props = memorySearch.tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('query');
    expect(props).toHaveProperty('top_k');
    expect(props).toHaveProperty('path_prefix');
    expect(props).not.toHaveProperty('group');
  });

  it('memory_get_file_content accepts path and optional parse_frontmatter, no group', () => {
    const props = memoryGetFileContent.tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('path');
    expect(props).toHaveProperty('parse_frontmatter');
    expect(props).not.toHaveProperty('group');
  });

  it('memory_list_files accepts optional list params, no group', () => {
    const props = memoryListFiles.tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('path_prefix');
    expect(props).toHaveProperty('limit');
    expect(props).toHaveProperty('parse_frontmatter');
    expect(props).not.toHaveProperty('group');
  });
});

// ── surface-actor.MemoryMcpTools — specialist gating note ────────────────────
//
// The spec (guidance on MemorySearched, MemoryFileRead, MemoryListed) states that
// memory tools must not be registered in specialist containers. The gating is
// implemented at import time in mcp-tools/index.ts:
//
//   if (!isSpecialist) { await import('./memory.js'); }
//
// An integration test for specialist exclusion requires a way to reset the tool
// registry between test runs. Add `clearRegisteredTools()` to server.ts and
// expand this suite once that export exists.
//
// For now, the host-side session-group mismatch tests in src/memory/memory.test.ts
// cover the actor restriction: all three rule handlers throw when
// session.agent_group_id !== group_id.

// The host stores an indexed mount's files at the path the container sees
// them (`extra/<mount>/…`), so a hit maps straight to its mount point; the
// group's own memory keeps its repo-relative form.
describe('resolveIndexedPath', () => {
  it('maps an indexed mount file to its mount point', () => {
    expect(resolveIndexedPath('extra/org/gtd.org')).toBe('/workspace/extra/org/gtd.org');
    expect(resolveIndexedPath('extra/org/projects/nanoclaw.org')).toBe('/workspace/extra/org/projects/nanoclaw.org');
  });

  it("maps the group's own memory into its workspace", () => {
    expect(resolveIndexedPath('groups/dm-with-alanz/memory/notes/x.md')).toBe('/workspace/agent/memory/notes/x.md');
  });

  it('refuses a path that would leave /workspace/extra, and the old ../ form', () => {
    expect(resolveIndexedPath('extra/../agent/secrets')).toBeNull();
    expect(resolveIndexedPath('extra/org/../../../etc/passwd')).toBeNull();
    expect(resolveIndexedPath('../Sync/org/gtd.org')).toBeNull();
  });
});
