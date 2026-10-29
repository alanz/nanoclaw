import { MEMORY_CONFIG, type MemoryConfig } from './config.js';
import { getMemoryManager, memoryAccessFor, type MemoryAccessSession } from './manager.js';

type Session = MemoryAccessSession;

/** A session searches only the one group it may read (spec: memory_group_for). */
async function assertSessionMayRead(session: Session, group_id: string): Promise<void> {
  const access = await memoryAccessFor(session);
  if (access?.groupId !== group_id) {
    throw new Error(`Session of group "${session.agent_group_id}" may not search the memory of group "${group_id}"`);
  }
}

export interface MemorySearchResponse {
  /** hybrid | keyword: which search produced the results; unavailable: no index for this group on the host. */
  mode: 'hybrid' | 'keyword' | 'unavailable';
  results: unknown[];
}

export async function handleMemorySearch(
  params: {
    session: Session;
    group_id: string;
    query: string;
    top_k?: number;
    path_prefix?: string;
    source?: string;
    min_score?: number;
    include_superseded?: boolean;
  },
  config: MemoryConfig = MEMORY_CONFIG,
): Promise<MemorySearchResponse> {
  await assertSessionMayRead(params.session, params.group_id);

  const manager = getMemoryManager(params.group_id);
  if (!manager) return { mode: 'unavailable', results: [] };

  return manager.search(params.query, {
    maxResults: Math.min(params.top_k ?? config.search_top_k, 20),
    // Unset stays unset: the manager picks the floor for the mode the search
    // actually ran in — hybrid, or keyword-only when the query could not be
    // embedded (min_keyword_score). Defaulting here pinned keyword-only
    // searches to the hybrid floor, dropping every weak keyword match.
    minScore: params.min_score ?? undefined,
    pathPrefix: params.path_prefix || undefined,
    source: params.source || undefined,
    includeSuperseded: params.include_superseded === true,
    embedWaitMs: config.search_embed_wait_ms,
  });
}
