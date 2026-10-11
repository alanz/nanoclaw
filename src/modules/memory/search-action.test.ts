/**
 * memory_search_request: the container's memory_search, answered on the host
 * (specs/memory.allium, MemorySearched). Drives the registered delivery action.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const { mockSearch, mockWrite, excluded } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockWrite: vi.fn().mockResolvedValue(undefined),
  excluded: new Set<string>(),
}));

vi.mock('../../memory/search.js', () => ({ handleMemorySearch: mockSearch }));
vi.mock('../../memory/manager.js', () => ({ isMemoryGroupExcluded: (id: string) => excluded.has(id) }));
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  writeSessionMessage: mockWrite,
}));

import { getDeliveryAction } from '../../delivery.js';
import './search-action.js';

const session = { id: 'sess-1', agent_group_id: 'ag-mine', messaging_group_id: 'mg-1' } as Session;

function written(): Record<string, unknown> {
  expect(mockWrite).toHaveBeenCalledTimes(1);
  const [groupId, sessionId, message] = mockWrite.mock.calls[0]!;
  expect([groupId, sessionId]).toEqual(['ag-mine', 'sess-1']);
  expect(message).toMatchObject({ id: 'memory-search-resp-r1', kind: 'system', trigger: false });
  return JSON.parse(message.content);
}

beforeEach(() => {
  mockSearch.mockReset();
  mockWrite.mockClear();
  excluded.clear();
});

describe('memory_search_request', () => {
  it("searches the calling session's own group and writes the answer without a wake", async () => {
    mockSearch.mockResolvedValue({ mode: 'hybrid', results: [{ path: 'a.md' }] });
    await getDeliveryAction('memory_search_request')!(
      {
        requestId: 'r1',
        query: 'emacs',
        top_k: 3,
        path_prefix: 'groups/g/zettel/notes/',
        source: 'zettel',
        min_score: 0.5,
        group_id: 'ag-other',
      },
      session,
    );
    expect(mockSearch).toHaveBeenCalledWith({
      session,
      group_id: 'ag-mine',
      query: 'emacs',
      top_k: 3,
      path_prefix: 'groups/g/zettel/notes/',
      source: 'zettel',
      min_score: 0.5,
    });
    expect(written()).toEqual({
      type: 'memory_search_response',
      requestId: 'r1',
      mode: 'hybrid',
      results: [{ path: 'a.md' }],
    });
  });

  it('passes on only a usable 0–1 min_score, so the host default applies otherwise', async () => {
    mockSearch.mockResolvedValue({ mode: 'hybrid', results: [] });
    for (const min_score of [undefined, -1, 2, '0.5']) {
      await getDeliveryAction('memory_search_request')!({ requestId: 'r1', query: 'q', min_score }, session);
    }
    for (const call of mockSearch.mock.calls) expect(call[0].min_score).toBeUndefined();
  });

  it('answers unavailable for an excluded group without searching', async () => {
    excluded.add('ag-mine');
    await getDeliveryAction('memory_search_request')!({ requestId: 'r1', query: 'q' }, session);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ mode: 'unavailable', results: [] });
  });

  it('answers with the error when the search throws, so the container falls back at once', async () => {
    mockSearch.mockRejectedValue(new Error('memory_search_enabled is false'));
    await getDeliveryAction('memory_search_request')!({ requestId: 'r1', query: 'q' }, session);
    expect(written()).toEqual({
      type: 'memory_search_response',
      requestId: 'r1',
      error: 'memory_search_enabled is false',
    });
  });

  it('drops a request without a requestId or query', async () => {
    await getDeliveryAction('memory_search_request')!({ query: 'q' }, session);
    await getDeliveryAction('memory_search_request')!({ requestId: 'r1' }, session);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
