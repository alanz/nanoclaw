import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const moduleZotero: Migration = {
  version: 50,
  name: 'module-zotero',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE zotero_sync_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id),
        last_version    INTEGER NOT NULL DEFAULT 0,
        total_items     INTEGER NOT NULL DEFAULT 0,
        last_sync       TEXT,
        next_check      TEXT,
        schedule_type   TEXT NOT NULL DEFAULT 'interval',
        schedule_value  TEXT NOT NULL DEFAULT '3600000',
        updated_at      TEXT NOT NULL
      );
    `);
  },
};
