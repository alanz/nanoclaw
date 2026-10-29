/**
 * The host search path leaves an unset min_score unset, so the manager picks
 * the floor for the mode the search ran in. Defaulting it here to the hybrid
 * floor (0.35) pinned keyword-only searches — the ones run when the query
 * cannot be embedded — to a floor their scores rarely reach (spec:
 * MemorySearched, min_keyword_score).
 */
import { describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ opts: [] as Array<{ minScore?: number }> }));

vi.mock('./manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manager.js')>()),
  getMemoryManager: () => ({
    search: async (_q: string, opts: { minScore?: number }) => {
      seen.opts.push(opts);
      return { mode: 'keyword', results: [] };
    },
  }),
}));

import { handleMemorySearch } from './search.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-g' };

describe('host memory search floor', () => {
  it('leaves min_score unset when the caller gave none', async () => {
    seen.opts.length = 0;
    await handleMemorySearch({ session: SESSION, group_id: 'ag-g', query: 'zebra' });
    expect(seen.opts[0].minScore).toBeUndefined();
  });

  it("passes a caller's min_score through", async () => {
    seen.opts.length = 0;
    await handleMemorySearch({ session: SESSION, group_id: 'ag-g', query: 'zebra', min_score: 0.2 });
    expect(seen.opts[0].minScore).toBe(0.2);
  });
});
