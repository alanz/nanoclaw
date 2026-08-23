import type Database from 'better-sqlite3';

import { registerMigration } from './index.js';

registerMigration({
  version: 30,
  name: 'module:memory:index',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_files (
        id           TEXT PRIMARY KEY,
        group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        path         TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at   TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_files_group_path ON memory_files(group_id, path);

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id         TEXT PRIMARY KEY,
        file_id    TEXT NOT NULL REFERENCES memory_files(id),
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        content    TEXT NOT NULL,
        hash       TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_file_id ON memory_chunks(file_id);
    `);
  },
});
