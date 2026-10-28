/**
 * Which way a container transfer travels (specs/specialists.allium
 * TransferKind). 'result': a specialist's delivery back to its requester —
 * task_id is the delivering task. 'dispatch': files handed to a specialist
 * with the task that dispatches it — task_id is the dispatched task, and
 * recipient_session_id its per-task session from the start. Every row
 * written before this column is a result.
 */
import type Database from 'better-sqlite3';

import { registerMigration } from './index.js';
import { addColumnIfMissing } from './legacy-names.js';

registerMigration({
  version: 63,
  name: 'module:specialists:transfer-kind',
  sqliteOnly: true,
  up(db: Database.Database) {
    addColumnIfMissing(db, 'container_transfers', 'kind', "TEXT NOT NULL DEFAULT 'result'");
  },
});
