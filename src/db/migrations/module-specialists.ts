import type Database from 'better-sqlite3';

import { registerMigration } from './index.js';

registerMigration({
  version: 20,
  name: 'module:specialists:core',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      -- agent_groups.is_main is created by module:concurrency:agent-group-is-main.
      -- It is a property of an agent group, not of this feature, and the
      -- concurrency cap reads the same column to exempt the operator's line.

      CREATE TABLE IF NOT EXISTS specialists (
        agent_group_id        TEXT PRIMARY KEY REFERENCES agent_groups(id),
        is_memory_provider    INTEGER NOT NULL DEFAULT 0,
        last_turn_sub_notice   TEXT,
        last_turn_parent_notice TEXT,
        created_at            TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS specialist_tasks (
        id                        TEXT PRIMARY KEY,
        specialist_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
        prompt                    TEXT NOT NULL,
        requester_group_id        TEXT REFERENCES agent_groups(id),
        requester_task_id         TEXT REFERENCES specialist_tasks(id),
        requester_session_id      TEXT NOT NULL REFERENCES sessions(id),
        depth                     INTEGER NOT NULL DEFAULT 0,
        chain_delegation_count    INTEGER NOT NULL DEFAULT 1,
        ancestor_group_ids        TEXT NOT NULL DEFAULT '[]',
        is_last_same_type_dispatch INTEGER NOT NULL DEFAULT 0,
        status                    TEXT NOT NULL DEFAULT 'queued',
        dispatched_at             TEXT NOT NULL,
        restart_attempt_count     INTEGER NOT NULL DEFAULT 0,
        closed_at                 TEXT,
        result                    TEXT,
        failure_kind              TEXT,
        failure_detail            TEXT,
        pending_sub_task_id       TEXT REFERENCES specialist_tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_specialist_tasks_status ON specialist_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_specialist_tasks_requester_task ON specialist_tasks(requester_task_id);
      CREATE INDEX IF NOT EXISTS idx_specialist_tasks_session ON specialist_tasks(requester_session_id);
    `);
  },
});
