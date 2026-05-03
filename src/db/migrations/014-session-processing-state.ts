/**
 * Add processing_state to sessions.
 *
 * processing_state tracks the container's work lifecycle as a persistent DB
 * column, implementing the ProcessingState enum from sessions.allium:
 *
 *   idle       — no container is working on this session
 *   processing — a container is actively running for this session
 *   stuck      — the container was running but exceeded the stuck ceiling
 *
 * The column is additive: existing container_status remains for other code
 * that still uses it. processing_state is set to 'idle' for all existing rows
 * (the DEFAULT) since any previously-running containers will have already
 * exited or will be treated as orphans on restart.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'session-processing-state',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE sessions ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'idle'`);
  },
};
