import { getDb } from '../../db/connection.js';
// The module owns this table, so it owns registering its migration.
import '../../db/migrations/module-zotero.js';

export interface ZoteroSyncState {
  agent_group_id: string;
  last_version: number;
  total_items: number;
  last_sync: string | null;
  next_check: string | null;
  schedule_type: 'interval' | 'cron';
  schedule_value: string;
  updated_at: string;
}

export async function getZoteroSyncState(): Promise<ZoteroSyncState | undefined> {
  return (await getDb().get('SELECT * FROM zotero_sync_state WHERE id = 1')) as ZoteroSyncState | undefined;
}

export async function upsertZoteroSyncState(state: Omit<ZoteroSyncState, 'updated_at'>): Promise<void> {
  await getDb().run(
    `INSERT INTO zotero_sync_state
         (id, agent_group_id, last_version, total_items, last_sync, next_check, schedule_type, schedule_value, updated_at)
       VALUES (1, @agent_group_id, @last_version, @total_items, @last_sync, @next_check, @schedule_type, @schedule_value, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         agent_group_id  = excluded.agent_group_id,
         last_version    = excluded.last_version,
         total_items     = excluded.total_items,
         last_sync       = excluded.last_sync,
         next_check      = excluded.next_check,
         schedule_type   = excluded.schedule_type,
         schedule_value  = excluded.schedule_value,
         updated_at      = excluded.updated_at`,
    state,
  );
}

export async function updateNextCheck(nextCheck: string): Promise<void> {
  await getDb().run(
    "UPDATE zotero_sync_state SET next_check = ?, updated_at = datetime('now') WHERE id = 1",
    nextCheck,
  );
}

export async function updateAfterSync(
  lastVersion: number,
  totalItems: number,
  lastSync: string,
  nextCheck: string,
): Promise<void> {
  await getDb().run(
    `UPDATE zotero_sync_state
       SET last_version = ?, total_items = ?, last_sync = ?, next_check = ?, updated_at = datetime('now')
       WHERE id = 1`,
    lastVersion,
    totalItems,
    lastSync,
    nextCheck,
  );
}
