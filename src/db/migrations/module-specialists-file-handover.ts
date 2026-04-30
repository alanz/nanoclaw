import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const moduleSpecialistsFileHandover: Migration = {
  version: 21,
  name: 'module-specialists-file-handover',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE specialist_tasks ADD COLUMN committed_files TEXT;

      CREATE TABLE invocations (
        id                TEXT PRIMARY KEY,
        session_id        TEXT NOT NULL REFERENCES sessions(id),
        task_id           TEXT REFERENCES specialist_tasks(id),
        ipc_out_host_path TEXT NOT NULL,
        ipc_in_host_path  TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        ended_at          TEXT
      );
      CREATE INDEX idx_invocations_session ON invocations(session_id);

      CREATE TABLE ipc_out_mounts (
        id            TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL REFERENCES invocations(id),
        status        TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE ipc_in_mounts (
        id            TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL REFERENCES invocations(id),
        status        TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE container_transfers (
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
      CREATE INDEX idx_container_transfers_task ON container_transfers(task_id);
      CREATE INDEX idx_container_transfers_recipient ON container_transfers(recipient_session_id);

      CREATE TABLE transfer_files (
        id            TEXT PRIMARY KEY,
        transfer_id   TEXT NOT NULL REFERENCES container_transfers(id),
        original_name TEXT NOT NULL,
        host_path     TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'owned',
        memory_path   TEXT
      );
      CREATE INDEX idx_transfer_files_transfer ON transfer_files(transfer_id);
    `);
  },
};
