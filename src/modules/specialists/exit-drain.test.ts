/**
 * A specialist container exits right after dispatch_sub_task or
 * deliver_specialist_result. The 1s delivery poll only covers sessions with a
 * running container, so the exit hook must hand the container's last outbound
 * rows to delivery itself — and before ending the invocation, because ending
 * it clears ipc-out, which deliver_specialist_result takes its files from.
 *
 * Only a specialist task's session has such rows. Every session gets an
 * invocation, so the hook must not drain ordinary sessions: it did, from
 * inside the sweep's own mailbox session on an idle reap, and logged
 * "Nested mailbox session" (the nesting itself is covered in
 * session-manager.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  contributors: [] as Array<(ctx: unknown) => unknown>,
  exits: [] as Array<(e: { sessionId: string }) => void>,
  order: [] as string[],
  sessions: new Map<string, { id: string; agent_group_id: string; thread_id: string | null }>(),
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
  getSession: vi.fn(async (id: string) => hooks.sessions.get(id)),
}));

vi.mock('./db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db.js')>()),
  getTask: vi.fn(async (id: string) => (id === 'task-1' ? { id, status: 'running' } : undefined)),
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

async function exitSession(id: string, threadId: string | null): Promise<void> {
  hooks.sessions.set(id, { id, agent_group_id: 'ag-1', thread_id: threadId });
  // The file-handover contributor (registered first) records the invocation.
  await hooks.contributors[0]({ session: { id }, agentGroup: { id: 'ag-1' } });
  for (const exit of hooks.exits) exit({ sessionId: id });
  await vi.waitFor(() => expect(hooks.order.at(-1)).toBe('end-invocation'));
}

beforeEach(() => {
  hooks.order.length = 0;
  vi.mocked(deliverSessionMessages).mockClear();
});

describe('specialist session exit', () => {
  it("delivers a task session's last outbound rows, waiting for any in-flight drain, before ending its invocation", async () => {
    await exitSession('sess-task', 'task-1');

    expect(hooks.order).toEqual(['drain', 'end-invocation']);
    expect(deliverSessionMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-task' }), {
      waitForInflight: true,
    });
  });

  it('only ends the invocation of a session that is not a specialist task', async () => {
    await exitSession('sess-main', null);

    expect(hooks.order).toEqual(['end-invocation']);
    expect(deliverSessionMessages).not.toHaveBeenCalled();
  });
});
