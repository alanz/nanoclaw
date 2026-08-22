import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export async function createUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at)
     VALUES (@id, @kind, @display_name, @created_at)`,
    user,
  );
}

export async function upsertUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name)`,
    user,
  );
}

export async function getUser(id: string): Promise<User | undefined> {
  return getDb().get<User>('SELECT * FROM users WHERE id = ?', id);
}

export async function getAllUsers(): Promise<User[]> {
  return getDb().all<User>('SELECT * FROM users ORDER BY created_at');
}

export async function updateDisplayName(id: string, displayName: string): Promise<void> {
  await getDb().run('UPDATE users SET display_name = ? WHERE id = ?', displayName, id);
}

export async function deleteUser(id: string): Promise<void> {
  await getDb().run('DELETE FROM users WHERE id = ?', id);
}

/**
 * Fold `sourceIds` into `target`: the one person had several user ids (e.g. a
 * channel whose sender id used to change) and now has one stable id. Roles and
 * memberships move to the target (duplicates collapse), approver references
 * are repointed, cached DM rows are dropped so the next cold DM re-resolves,
 * and the source users are deleted. Sources that do not exist are ignored;
 * returns the ids actually merged. Runs in one transaction.
 */
export async function mergeUsersInto(target: User, sourceIds: string[]): Promise<string[]> {
  const db = getDb();
  return db.transaction(async () => {
    const merged: string[] = [];
    for (const id of sourceIds) {
      if (id !== target.id && (await getUser(id))) merged.push(id);
    }
    if (merged.length === 0) return merged;

    if (!(await getUser(target.id))) await createUser(target);

    for (const src of merged) {
      await db.run(
        `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
           SELECT ?, r.role, r.agent_group_id, r.granted_by, r.granted_at FROM user_roles r
           WHERE r.user_id = ? AND NOT EXISTS (
             SELECT 1 FROM user_roles t WHERE t.user_id = ? AND t.role = r.role
               AND t.agent_group_id IS r.agent_group_id)`,
        target.id,
        src,
        target.id,
      );
      await db.run('DELETE FROM user_roles WHERE user_id = ?', src);
      await db.run('UPDATE user_roles SET granted_by = ? WHERE granted_by = ?', target.id, src);

      await db.run(
        `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
           SELECT ?, m.agent_group_id, m.added_by, m.added_at FROM agent_group_members m
           WHERE m.user_id = ? AND NOT EXISTS (
             SELECT 1 FROM agent_group_members t WHERE t.user_id = ? AND t.agent_group_id = m.agent_group_id)`,
        target.id,
        src,
        target.id,
      );
      await db.run('DELETE FROM agent_group_members WHERE user_id = ?', src);
      await db.run('UPDATE agent_group_members SET added_by = ? WHERE added_by = ?', target.id, src);

      await db.run('DELETE FROM user_dms WHERE user_id = ?', src);

      await db.run('UPDATE pending_approvals SET approver_user_id = ? WHERE approver_user_id = ?', target.id, src);
      await db.run(
        'UPDATE pending_sender_approvals SET approver_user_id = ? WHERE approver_user_id = ?',
        target.id,
        src,
      );
      await db.run(
        'UPDATE pending_channel_approvals SET approver_user_id = ? WHERE approver_user_id = ?',
        target.id,
        src,
      );
      await db.run('UPDATE agent_message_policies SET approver = ? WHERE approver = ?', target.id, src);

      await deleteUser(src);
    }
    return merged;
  });
}
