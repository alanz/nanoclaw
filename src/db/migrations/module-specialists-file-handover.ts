import type Database from 'better-sqlite3';

import { registerMigration } from './index.js';
import { addColumnIfMissing } from './legacy-names.js';

registerMigration({
  version: 21,
  name: 'module:specialists:file-handover',
  sqliteOnly: true,
  up(db: Database.Database) {
    // Guarded for the same reason as the tables below: this may have run
    // already under 'module-specialists-file-handover'. See legacy-names.ts.
    addColumnIfMissing(db, 'specialist_tasks', 'committed_files', 'TEXT');
    db.exec(`

      CREATE TABLE IF NOT EXISTS invocations (
        id                TEXT PRIMARY KEY,
        session_id        TEXT NOT NULL REFERENCES sessions(id),
        task_id           TEXT REFERENCES specialist_tasks(id),
        ipc_out_host_path TEXT NOT NULL,
        ipc_in_host_path  TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        ended_at          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invocations_session ON invocations(session_id);

      CREATE TABLE IF NOT EXISTS ipc_out_mounts (
        id            TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL REFERENCES invocations(id),
        status        TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS ipc_in_mounts (
        id            TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL REFERENCES invocations(id),
        status        TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS container_transfers (
        id                    TEXT PRIMARY KEY,
        task_id               TEXT NOT NULL REFERENCES specialist_tasks(id),
        sender_invocation_id  TEXT NOT NULL REFERENCES invocations(id),
        result_text           TEXT NOT NULL,
        commit_to_memory      INTEGER NOT NULL DEFAULT 0,
        file_count            INTEGER NOT NULL DEFAULT 0,
        sent_at               TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'pending',
        recipient_session_id  TEXT REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_container_transfers_task ON container_transfers(task_id);
      CREATE INDEX IF NOT EXISTS idx_container_transfers_recipient ON container_transfers(recipient_session_id);

      CREATE TABLE IF NOT EXISTS transfer_files (
        id            TEXT PRIMARY KEY,
        transfer_id   TEXT NOT NULL REFERENCES container_transfers(id),
        original_name TEXT NOT NULL,
        host_path     TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'owned',
        memory_path   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_transfer_files_transfer ON transfer_files(transfer_id);
    `);
  },
});
