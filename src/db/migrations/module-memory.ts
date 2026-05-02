import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const moduleMemory: Migration = {
  version: 30,
  name: 'module-memory',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE memory_files (
        id           TEXT PRIMARY KEY,
        group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        path         TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at   TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_memory_files_group_path ON memory_files(group_id, path);

      CREATE TABLE memory_chunks (
        id         TEXT PRIMARY KEY,
        file_id    TEXT NOT NULL REFERENCES memory_files(id),
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        content    TEXT NOT NULL,
        hash       TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX idx_memory_chunks_file_id ON memory_chunks(file_id);
    `);
  },
};
