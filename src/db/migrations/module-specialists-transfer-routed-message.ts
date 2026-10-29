/**
 * Record on a container transfer the inbound message that carried its result
 * to a main-agent requester (specs/specialists.allium ContainerTransfer
 * .routed_message). Whether that message has been handled decides, when the
 * main agent's container exits, if the transfer's files are done with
 * (expire) or still owed to the turn that will read the message (back to
 * pending, re-placed at the next start). Null for sub-task transfers and for
 * rows written before this column.
 */
import type Database from 'better-sqlite3';

import { registerMigration } from './index.js';
import { addColumnIfMissing } from './legacy-names.js';

registerMigration({
  version: 62,
  name: 'module:specialists:transfer-routed-message',
  sqliteOnly: true,
  up(db: Database.Database) {
    addColumnIfMissing(db, 'container_transfers', 'routed_message_id', 'TEXT');
  },
});
