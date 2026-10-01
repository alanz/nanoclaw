/** Removing a deleted agent group's Zotero sync state, for `ncl groups delete`. */
import { hasTable } from '../../db/connection.js';
import { registerGroupDeleteStep } from '../../group-delete.js';

// Sync state is per group; a deleted group takes it with it.
registerGroupDeleteStep({
  name: 'zotero',
  async run(db, id) {
    if (!(await hasTable(db, 'zotero_sync_state'))) return 0;
    return (await db.run('DELETE FROM zotero_sync_state WHERE agent_group_id = ?', id)).changes;
  },
});
