/**
 * A successful root dispatch is noted in the caller's session as context, not
 * as a trigger: a triggering note started a turn of its own after the agent's
 * reply, and the agent answered it to the user ("Noted. I'll send the
 * report…", 2026-10-12).
 */
import { describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as Array<{ sessionId: string; message: { trigger?: boolean; content: string } }>);

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(
    async (_ag: string, sessionId: string, message: { trigger?: boolean; content: string }) => {
      writes.push({ sessionId, message });
    },
  ),
  initSessionFolder: vi.fn(),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => ({ id, name: 'Researcher', folder: 'specialists-researcher' })),
}));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn(async () => true) }));
vi.mock('../../channels/null-channel.js', () => ({ getNullMessagingGroupId: vi.fn(async () => 'mg-null') }));
vi.mock('./session-helpers.js', () => ({
  createSpecialistSession: vi.fn(async (agentGroupId: string) => ({ id: 'sess-spec', agent_group_id: agentGroupId })),
}));
vi.mock('./db.js', () => ({
  createTask: vi.fn(async () => {}),
  getLiveTaskForSession: vi.fn(),
  getSpecialist: vi.fn(async () => ({ agent_group_id: 'ag-rsrch', is_memory_provider: 0 })),
  isMainGroup: vi.fn(async () => true),
  sameTypeDispatchCount: vi.fn(async () => 0),
  updateTaskStatus: vi.fn(),
}));

import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import { handleDispatchSpecialist } from './dispatch.js';

describe('root dispatch acknowledgement', () => {
  it('is written to the caller as context, without a trigger or a wake', async () => {
    const session = { id: 'sess-main', agent_group_id: 'ag-main' } as Session;

    await handleDispatchSpecialist({ specialist_group_id: 'ag-rsrch', prompt: 'look into X' }, session);

    await vi.waitFor(() => expect(writes.some((w) => w.sessionId === 'sess-main')).toBe(true));
    const note = writes.find((w) => w.sessionId === 'sess-main')!;
    expect(note.message.trigger).toBe(false);
    expect(JSON.parse(note.message.content).text).toMatch(/^Specialist task dispatched \(id: task-/);
    expect(requestWake).not.toHaveBeenCalled();
  });
});
