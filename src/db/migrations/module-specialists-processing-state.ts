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

import { registerMigration } from './index.js';
import { addColumnIfMissing } from './legacy-names.js';

registerMigration({
  version: 14,
  name: 'module:specialists:processing-state',
  sqliteOnly: true,
  up(db: Database.Database) {
    // Guarded: an install that ran this under its pre-`module:` name
    // ('session-processing-state') already has the column. See legacy-names.ts.
    addColumnIfMissing(db, 'sessions', 'processing_state', "TEXT NOT NULL DEFAULT 'idle'");
  },
});
