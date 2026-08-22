import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initSqliteTestDb } from '../../../db/connection.js';
import { createMessagingGroup } from '../../../db/messaging-groups.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { addMember, getMembers } from './agent-group-members.js';
import { getUserDm, upsertUserDm } from './user-dms.js';
import { getUserRoles, grantRole } from './user-roles.js';
import { createUser, getUser, mergeUsersInto } from './users.js';

const now = () => new Date().toISOString();
const OLD_A = 'dc:a@relay-one.example';
const OLD_B = 'dc:b@relay-two.example';
const TARGET = {
  id: 'dc:fp:0123456789ABCDEF0123456789ABCDEF01234567',
  kind: 'deltachat',
  display_name: 'alan',
  created_at: '',
};

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  for (const id of [OLD_A, OLD_B]) await createUser({ id, kind: 'deltachat', display_name: null, created_at: now() });
});

afterEach(async () => {
  await closeDb();
});

describe('mergeUsersInto', () => {
  it('moves roles and memberships, collapsing duplicates, and deletes the sources', async () => {
    await grantRole({ user_id: OLD_A, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    await grantRole({ user_id: OLD_B, role: 'owner', agent_group_id: null, granted_by: OLD_A, granted_at: now() });
    await grantRole({ user_id: OLD_B, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    await addMember({ user_id: OLD_A, agent_group_id: 'ag-1', added_by: null, added_at: now() });

    const merged = await mergeUsersInto(TARGET, [OLD_A, OLD_B, 'dc:never-seen@example.org']);

    expect(merged).toEqual([OLD_A, OLD_B]);
    expect(await getUser(OLD_A)).toBeUndefined();
    expect(await getUser(OLD_B)).toBeUndefined();
    expect((await getUser(TARGET.id))?.display_name).toBe('alan');

    const roles = await getUserRoles(TARGET.id);
    expect(roles.map((r) => `${r.role}:${r.agent_group_id}`).sort()).toEqual(['admin:ag-1', 'owner:null']);
    expect(roles.find((r) => r.role === 'owner')?.granted_by).toBeNull();
    expect((await getMembers('ag-1')).map((m) => m.user_id)).toEqual([TARGET.id]);
  });

  it('repoints granted_by and drops cached DM rows', async () => {
    await createUser({ id: 'cli:local', kind: 'cli', display_name: null, created_at: now() });
    await grantRole({
      user_id: 'cli:local',
      role: 'admin',
      agent_group_id: null,
      granted_by: OLD_A,
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'deltachat',
      platform_id: 'dc:a@relay-one.example',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({ user_id: OLD_A, channel_type: 'deltachat', messaging_group_id: 'mg-dm', resolved_at: now() });

    await mergeUsersInto(TARGET, [OLD_A]);

    expect((await getUserRoles('cli:local'))[0].granted_by).toBe(TARGET.id);
    expect(await getUserDm(OLD_A, 'deltachat')).toBeUndefined();
    expect(await getUserDm(TARGET.id, 'deltachat')).toBeUndefined();
  });

  it('is a no-op when no source exists, and does not create the target', async () => {
    expect(await mergeUsersInto(TARGET, ['dc:nobody@example.org'])).toEqual([]);
    expect(await getUser(TARGET.id)).toBeUndefined();
  });

  it('rolls back everything if a step fails', async () => {
    await grantRole({ user_id: OLD_A, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    await getDb().exec('DROP TABLE agent_message_policies');

    await expect(mergeUsersInto(TARGET, [OLD_A])).rejects.toThrow();
    expect(await getUser(OLD_A)).toBeDefined();
    expect(await getUser(TARGET.id)).toBeUndefined();
    expect(await getUserRoles(OLD_A)).toHaveLength(1);
  });
});
