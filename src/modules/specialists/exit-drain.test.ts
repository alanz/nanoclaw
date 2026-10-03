/**
 * A specialist container exits right after dispatch_sub_task or
 * deliver_specialist_result. The 1s delivery poll only covers sessions with a
 * running container, so the exit hook must hand the container's last outbound
 * rows to delivery itself — and before ending the invocation, because ending
 * it clears ipc-out, which deliver_specialist_result takes its files from.
 */
import { describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  contributors: [] as Array<(ctx: unknown) => unknown>,
  exits: [] as Array<(e: { sessionId: string }) => void>,
  order: [] as string[],
}));

vi.mock('../../container-runner.js', () => ({
  registerSessionContributor: (c: (ctx: unknown) => unknown) => hooks.contributors.push(c),
  registerSessionExitHook: (h: (e: { sessionId: string }) => void) => hooks.exits.push(h),
}));

vi.mock('../../delivery.js', () => ({
  registerDeliveryAction: vi.fn(),
  deliverSessionMessages: vi.fn(async () => {
    hooks.order.push('drain');
  }),
}));

vi.mock('../../db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/sessions.js')>()),
  getSession: vi.fn(async (id: string) => ({ id, agent_group_id: 'ag-spec' })),
}));

vi.mock('./invocation.js', () => ({
  buildInvocationForSession: vi.fn(async () => ({ mounts: [], invocationId: 'inv-1' })),
  endInvocationById: vi.fn(async () => {
    hooks.order.push('end-invocation');
  }),
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
}));

import { deliverSessionMessages } from '../../delivery.js';
import './index.js';

describe('specialist session exit', () => {
  it("delivers the container's last outbound rows before ending its invocation", async () => {
    // The file-handover contributor (registered first) records the invocation.
    await hooks.contributors[0]({ session: { id: 'sess-1' }, agentGroup: { id: 'ag-spec' } });

    for (const exit of hooks.exits) exit({ sessionId: 'sess-1' });
    await vi.waitFor(() => expect(hooks.order).toEqual(['drain', 'end-invocation']));
    expect(deliverSessionMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }));
  });
});
