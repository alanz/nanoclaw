import { findMemoryFile, getAllMemoryFiles, type MemoryFile } from './db.js';
import { MEMORY_CONFIG, type MemoryConfig } from './config.js';

type Session = { id: string; agent_group_id: string };

function assertSessionMatchesGroup(session: Session, group_id: string): void {
  if (session.agent_group_id !== group_id) {
    throw new Error(
      `Session agent_group_id "${session.agent_group_id}" does not match group "${group_id}"`,
    );
  }
}

function assertSearchEnabled(config: MemoryConfig): void {
  if (!config.memory_search_enabled) {
    throw new Error('memory_search_enabled is false');
  }
}

// memory_hybrid_search is a black-box host function (vector + FTS5 hybrid).
// Returns an empty list until the full embedding pipeline is wired.
export function handleMemorySearch(
  params: { session: Session; group_id: string; query: string; top_k?: number },
  config: MemoryConfig = MEMORY_CONFIG,
): unknown[] {
  assertSearchEnabled(config);
  assertSessionMatchesGroup(params.session, params.group_id);
  return [];
}

// memory_get_file_content is a black-box host function.
// Returns the MemoryFile record (path + metadata) for the indexed file.
export function handleMemoryGet(
  params: { session: Session; group_id: string; path: string; parse_frontmatter?: boolean },
  config: MemoryConfig = MEMORY_CONFIG,
): MemoryFile {
  assertSearchEnabled(config);
  assertSessionMatchesGroup(params.session, params.group_id);

  const file = findMemoryFile({ group_id: params.group_id, path: params.path });
  if (!file || file.status !== 'indexed') {
    throw new Error(`File not found or not indexed: ${params.path}`);
  }

  return file;
}

// memory_list_files is a black-box host function.
// Returns all indexed files for the group.
export function handleMemoryList(
  params: { session: Session; group_id: string; list_params?: unknown },
  config: MemoryConfig = MEMORY_CONFIG,
): MemoryFile[] {
  assertSearchEnabled(config);
  assertSessionMatchesGroup(params.session, params.group_id);

  return getAllMemoryFiles().filter(
    (f) => f.group_id === params.group_id && f.status !== 'removed',
  );
}
