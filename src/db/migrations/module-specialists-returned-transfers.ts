/**
 * The host's guarantee for named files (specs/specialists.allium
 * NamedFilesNeverLost) needs three more facts on a transfer and two on a file:
 *
 * - container_transfers.task_id becomes nullable: a returned transfer from a
 *   refused dispatch belongs to no task. SQLite cannot drop NOT NULL in
 *   place, so the table is recreated (FK enforcement off for the window).
 * - failed_task_id: for a returned transfer, the failed task whose files it
 *   gives back (null for a refused dispatch). Its recipient is
 *   recipient_session_id, set when it is created.
 * - returned_as: on a dispatch transfer whose files went back, the returned
 *   transfer now carrying them.
 * - transfer_files.parked_path: where a file nobody could read was parked,
 *   relative to the root requester group's folder.
 * - transfer_files.reached_recipient: the file was placed in a recipient's
 *   ipc-in at least once. Rows written before this column that were placed
 *   or retired without a memory path are taken to have reached theirs.
 */
import type Database from 'better-sqlite3';

import { registerMigration } from './index.js';
import { addColumnIfMissing } from './legacy-names.js';

registerMigration({
  version: 64,
  name: 'module:specialists:returned-transfers',
  sqliteOnly: true,
  disableForeignKeys: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE container_transfers_new (
        id                    TEXT PRIMARY KEY,
        kind                  TEXT NOT NULL DEFAULT 'result',
        task_id               TEXT REFERENCES specialist_tasks(id),
        sender_invocation_id  TEXT NOT NULL REFERENCES invocations(id),
        result_text           TEXT NOT NULL,
        commit_to_memory      INTEGER NOT NULL DEFAULT 0,
        file_count            INTEGER NOT NULL DEFAULT 0,
        sent_at               TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'pending',
        recipient_session_id  TEXT REFERENCES sessions(id),
        routed_message_id     TEXT,
        failed_task_id        TEXT,
        returned_as           TEXT
      );
      INSERT INTO container_transfers_new
        (id, kind, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status,
         recipient_session_id, routed_message_id)
      SELECT id, kind, task_id, sender_invocation_id, result_text, commit_to_memory, file_count, sent_at, status,
             recipient_session_id, routed_message_id
        FROM container_transfers;
      DROP TABLE container_transfers;
      ALTER TABLE container_transfers_new RENAME TO container_transfers;
      CREATE INDEX IF NOT EXISTS idx_container_transfers_task ON container_transfers(task_id);
      CREATE INDEX IF NOT EXISTS idx_container_transfers_recipient ON container_transfers(recipient_session_id);
      CREATE INDEX IF NOT EXISTS idx_container_transfers_failed_task ON container_transfers(failed_task_id);
    `);
    addColumnIfMissing(db, 'transfer_files', 'parked_path', 'TEXT');
    addColumnIfMissing(db, 'transfer_files', 'reached_recipient', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(
      "UPDATE transfer_files SET reached_recipient = 1 WHERE status IN ('placed', 'expired') AND memory_path IS NULL",
    );
  },
});
