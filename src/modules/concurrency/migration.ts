/**
 * `agent_groups.is_main` — which group is the operator's own line.
 *
 * Owned here rather than by whichever feature first needed it, because it is
 * a property of an agent group, not of a feature: the concurrency cap exempts
 * the main group, and the specialist dispatcher refuses to treat it as a
 * worker. Both read the same column, so exactly one of them must create it.
 *
 * Defaults to 0. An install that never sets it has no main group, which is
 * the correct reading of "not configured" for both consumers: the cap applies
 * to everything, and nothing is mistaken for the operator's line.
 */
import type Database from 'better-sqlite3';

import { registerMigration } from '../../db/migrations/index.js';
import { addColumnIfMissing } from '../../db/migrations/legacy-names.js';

registerMigration({
  version: 1,
  name: 'module:concurrency:agent-group-is-main',
  sqliteOnly: true,
  up(db: Database.Database) {
    // Guarded: an install that carried this column under the specialists
    // module (where it used to live) already has it. See legacy-names.ts.
    addColumnIfMissing(db, 'agent_groups', 'is_main', 'INTEGER NOT NULL DEFAULT 0');
  },
});
