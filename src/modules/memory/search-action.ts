/**
 * memory_search_request — the container's memory_search, fulfilled on the host
 * (specs/memory.allium, MemorySearched). The host holds the embedding key and
 * the embedding budget, so the hybrid search runs here; the container waits
 * for the response in inbound.db and runs keyword-only locally if none comes.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { isMemoryGroupExcluded } from '../../memory/manager.js';
import { handleMemorySearch, type MemorySearchResponse } from '../../memory/search.js';
import { writeSessionMessage } from '../../session-manager.js';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** A caller's min_score, when it is a usable 0–1 score; otherwise the host default applies. */
function scoreIn(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
}

registerDeliveryAction(
  'memory_search_request',
  async (content, session) => {
    const requestId = content.requestId;
    const query = content.query;
    if (typeof requestId !== 'string' || !requestId || typeof query !== 'string') {
      log.warn('memory_search_request missing requestId or query', { sessionId: session.id });
      return;
    }

    let response: MemorySearchResponse | { error: string };
    try {
      // The group is the calling session's, never one named in the request.
      response = isMemoryGroupExcluded(session.agent_group_id)
        ? { mode: 'unavailable', results: [] }
        : await handleMemorySearch({
            session,
            group_id: session.agent_group_id,
            query,
            top_k: typeof content.top_k === 'number' ? content.top_k : undefined,
            path_prefix: optionalString(content.path_prefix),
            source: optionalString(content.source),
            min_score: scoreIn(content.min_score),
          });
    } catch (err) {
      response = { error: err instanceof Error ? err.message : String(err) };
    }

    // Not a wake: the response answers a tool call that is waiting for it.
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `memory-search-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ type: 'memory_search_response', requestId, ...response }),
      trigger: false,
    });
    log.info('Memory search answered', {
      sessionId: session.id,
      requestId,
      mode: 'mode' in response ? response.mode : 'error',
      results: 'results' in response ? response.results.length : 0,
    });
  },
  unguarded("read-only search of the calling session's own group index"),
);
