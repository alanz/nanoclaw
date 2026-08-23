/**
 * A specialist's container exits as soon as it calls dispatch_sub_task, so a
 * rejection notice written afterwards may have nothing running to read it.
 * Unwoken, the task sat `running` with no container until recovery took it for
 * a crash and restarted it on a fresh conversation. The notice now wakes it.
 */
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(async () => {
    calls.push('write');
  }),
  initSessionFolder: vi.fn(),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: vi.fn(async (id: string) => ({ id, agent_group_id: 'ag-parent' })),
}));
vi.mock('../../request-wake.js', () => ({
  requestWake: vi.fn(async () => {
    calls.push('wake');
    return true;
  }),
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn() }));

import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import { handleDispatchSubTask } from './dispatch.js';

describe('dispatch rejection notice', () => {
  it('is written and then wakes the calling session', async () => {
    const session = { id: 'sess-parent', agent_group_id: 'ag-parent' } as Session;

    await handleDispatchSubTask({ specialist_group_id: '', prompt: '' }, session);

    await vi.waitFor(() => expect(calls).toEqual(['write', 'wake']));
    expect(requestWake).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-parent' }), 'inbound-message');
  });
});
