/** Removing a deleted agent group's memory-index rows, for `ncl groups delete`. */
import { hasTable } from '../../db/connection.js';
import { registerGroupDeleteStep } from '../../group-delete.js';

// The index's rows reference the group; a deleted group takes them with it.
registerGroupDeleteStep({
  name: 'memory',
  async run(db, id) {
    if (!(await hasTable(db, 'memory_files'))) return 0;
    const chunks = (
      await db.run('DELETE FROM memory_chunks WHERE file_id IN (SELECT id FROM memory_files WHERE group_id = ?)', id)
    ).changes;
    return chunks + (await db.run('DELETE FROM memory_files WHERE group_id = ?', id)).changes;
  },
});
