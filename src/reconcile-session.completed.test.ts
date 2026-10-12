/**
 * Inbound-completed hooks fire only once the session is quiet: the runner
 * acks a follow-up as soon as it pushes it into a running query, so a
 * 'completed' message can still be mid-turn (2026-10-12: ✅ landed 13 s
 * before the reply).
 */
import { describe, expect, it, vi } from 'vitest';

import { _dispatchInboundCompletedForTesting as dispatch, registerInboundCompletedHook } from './reconcile-session.js';
import type { Session } from './types.js';

const session = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const done = (id: string) => ({ id, kind: 'chat', platformId: 'dc:1', channelType: 'deltachat', threadId: null });

describe('inbound-completed hooks', () => {
  it('hold completions while the session is busy, then deliver them all once quiet', async () => {
    const hook = vi.fn();
    const remove = registerInboundCompletedHook(hook);
    try {
      await dispatch([done('m1')], session, false);
      expect(hook).not.toHaveBeenCalled();

      await dispatch([], session, true);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith([done('m1')], session);

      await dispatch([], session, true);
      expect(hook).toHaveBeenCalledTimes(1);
    } finally {
      remove();
    }
  });

  it('deliver at once when the session is already quiet', async () => {
    const hook = vi.fn();
    const remove = registerInboundCompletedHook(hook);
    try {
      await dispatch([done('m2')], session, true);
      expect(hook).toHaveBeenCalledWith([done('m2')], session);
    } finally {
      remove();
    }
  });
});
