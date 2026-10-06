import type Database from 'better-sqlite3';

import { registerMigration } from './index.js';

registerMigration({
  version: 60,
  name: 'module:session-reset:core',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      -- One provider conversation (Claude: one SDK session id) inside a chat
      -- session, from when the host first saw it to its archive and summary.
      CREATE TABLE IF NOT EXISTS session_conversations (
        session_id               TEXT NOT NULL REFERENCES sessions(id),
        conversation_id          TEXT NOT NULL,
        agent_group_id           TEXT NOT NULL REFERENCES agent_groups(id),
        status                   TEXT NOT NULL,
        end_reason               TEXT,
        first_seen_at            TEXT NOT NULL,
        ended_at                 TEXT,
        archive_path             TEXT,
        summary_status           TEXT NOT NULL DEFAULT 'not_started',
        summary_attempts         INTEGER NOT NULL DEFAULT 0,
        summary_target           TEXT,
        summary_task_id          TEXT,
        summary_task_session_id  TEXT,
        summary_path             TEXT,
        PRIMARY KEY (session_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_conversations_status
        ON session_conversations(status, summary_status);

      -- A reset waiting for the session's next container start to begin a
      -- fresh conversation; applied once the old conversation id is gone.
      CREATE TABLE IF NOT EXISTS session_resets (
        session_id       TEXT NOT NULL REFERENCES sessions(id),
        conversation_id  TEXT NOT NULL,
        requested_at     TEXT NOT NULL,
        status           TEXT NOT NULL,
        applied_at       TEXT,
        PRIMARY KEY (session_id, conversation_id)
      );

      -- The local date of each session's last daily check, so a host restart
      -- later the same day does not run the 04:00 decision again.
      CREATE TABLE IF NOT EXISTS session_reset_checks (
        session_id       TEXT PRIMARY KEY REFERENCES sessions(id),
        last_checked_on  TEXT NOT NULL
      );
    `);
  },
});
