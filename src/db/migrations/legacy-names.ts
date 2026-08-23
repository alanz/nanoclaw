/**
 * Re-applying a migration that already ran under a different name.
 *
 * These modules predate the `module:<owner>:<id>` naming that
 * `registerMigration` enforces. An install that ran them under the old names
 * (`module-specialists`, `module-memory`, `session-processing-state`, …) has
 * the tables but not the new names, and the runner decides what is pending by
 * NAME — so it would try to create tables that already exist and fail the
 * host's startup.
 *
 * The honest reading is that the work IS done and only its identity changed,
 * so these helpers let the `up` bodies no-op rather than throw. They are
 * deliberately not a rewrite of `schema_version`: mutating recorded migration
 * history to make the present tidy is a worse trade than a guarded DDL that
 * says what it is doing.
 *
 * On a fresh install every guard is simply true and the DDL runs as written.
 */
import type Database from 'better-sqlite3';

/** True when `table` already has `column` — SQLite has no ADD COLUMN IF NOT EXISTS. */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/** Add a column only if it is missing. */
export function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
