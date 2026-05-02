import { findMemoryFile, getAllMemoryFiles, type MemoryFile } from './db.js';
import { MEMORY_CONFIG, type MemoryConfig } from './config.js';
import { getMemoryManager } from './manager.js';

type Session = { id: string; agent_group_id: string };

function assertSessionMatchesGroup(session: Session, group_id: string): void {
  if (session.agent_group_id !== group_id) {
    throw new Error(`Session agent_group_id "${session.agent_group_id}" does not match group "${group_id}"`);
  }
}

function assertSearchEnabled(config: MemoryConfig): void {
  if (!config.memory_search_enabled) {
    throw new Error('memory_search_enabled is false');
  }
}

export async function handleMemorySearch(
  params: { session: Session; group_id: string; query: string; top_k?: number },
  config: MemoryConfig = MEMORY_CONFIG,
): Promise<unknown[]> {
  assertSearchEnabled(config);
  assertSessionMatchesGroup(params.session, params.group_id);

  const manager = getMemoryManager(params.group_id);
  if (!manager) return [];

  return manager.search(params.query, {
    maxResults: params.top_k ?? config.search_top_k,
    minScore: config.min_search_score,
  });
}

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

export function handleMemoryList(
  params: { session: Session; group_id: string; list_params?: unknown },
  config: MemoryConfig = MEMORY_CONFIG,
): MemoryFile[] {
  assertSearchEnabled(config);
  assertSessionMatchesGroup(params.session, params.group_id);

  return getAllMemoryFiles().filter((f) => f.group_id === params.group_id && f.status !== 'removed');
}
