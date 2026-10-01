/**
 * A specialist group's folder is a shared template: its sessions get it
 * read-only, and the runner is told so through the same contribution — the
 * mount and the runner's behaviour come from one decision.
 *
 * Restored after the rebuild onto upstream dropped both halves: the folder was
 * mounted writable again, and nothing told the runner to skip writing its
 * memory scaffold there (archive 1274976b: 241 boot crashes when the two
 * disagreed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The file-handover contributor is not what is under test and touches the
// filesystem; a session with no invocation is a valid answer for it.
vi.mock('./invocation.js', () => ({
  buildInvocationForSession: vi.fn().mockResolvedValue(null),
  endInvocationById: vi.fn(),
  endActiveInvocationForSession: vi.fn(),
  expireTransfersForTerminalTask: vi.fn(),
  placeTransferIntoActiveIpcIn: vi.fn(),
}));

import { withSessionContributions } from '../../container-runner.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { AgentGroup, Session } from '../../types.js';
import { createSpecialist } from './db.js';
import './index.js';

function now(): string {
  return new Date().toISOString();
}

async function group(id: string, specialist: boolean): Promise<AgentGroup> {
  const row = { id, name: id, folder: id, agent_provider: null, created_at: now() };
  await createAgentGroup(row);
  if (specialist) {
    await createSpecialist({
      agent_group_id: id,
      is_memory_provider: 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: now(),
    });
  }
  return row as AgentGroup;
}

function session(agentGroup: AgentGroup): Session {
  return { id: `sess-${agentGroup.id}`, agent_group_id: agentGroup.id } as Session;
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('specialist workspace contribution', () => {
  it('makes a specialist group folder read-only, tells the runner, and asks for a clean conversation', async () => {
    const researcher = await group('ag-rsrch', true);
    const contribution = await withSessionContributions({}, { agentGroup: researcher, session: session(researcher) });

    expect(contribution.readonlyWorkspace).toBe(true);
    expect(contribution.env).toMatchObject({
      NANOCLAW_WORKSPACE_READONLY: '1',
      NANOCLAW_FRESH_CONVERSATION: '1',
    });
  });

  it('leaves an ordinary group writable, resuming its conversation', async () => {
    const main = await group('ag-main', false);
    const contribution = await withSessionContributions({}, { agentGroup: main, session: session(main) });

    expect(contribution.readonlyWorkspace).toBe(false);
    expect(contribution.env).not.toHaveProperty('NANOCLAW_WORKSPACE_READONLY');
    expect(contribution.env).not.toHaveProperty('NANOCLAW_FRESH_CONVERSATION');
  });
});
