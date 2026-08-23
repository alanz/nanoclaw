/**
 * Rehearse the migration path against a COPY of a real database.
 *
 * An upgrade's riskiest moment is the first startup against real data, and by
 * then the host is already down. This runs exactly what startup runs — the
 * registered migration set, in the same order, through the same runner —
 * against a copy, so a failure costs nothing.
 *
 * It exists because a rename caught us out: migrations that had already run
 * under pre-`module:` names looked pending to the runner, which decides by
 * name, and re-running their DDL would have failed the host's startup. The
 * modules are guarded now (see db/migrations/legacy-names.ts); this is how
 * you check that they still are on an install you did not anticipate.
 *
 *   cp data/v2.db /tmp/probe.db
 *   pnpm exec tsx scripts/check-migrations.ts /tmp/probe.db
 *
 * Refuses a path under data/ so it cannot be pointed at the live database.
 */
import path from 'path';

import { initDb, closeDb, getDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrations/index.js';
// Side-effect import: modules register their migrations, exactly as the host does.
import '../src/modules/index.js';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: tsx scripts/check-migrations.ts <path-to-db-copy>');
    process.exit(2);
  }
  const resolved = path.resolve(target);
  if (resolved.includes(`${path.sep}data${path.sep}`)) {
    console.error(`Refusing to migrate ${resolved}: it looks like live state. Copy it somewhere else first.`);
    process.exit(2);
  }

  const db = await initDb(resolved, { role: 'migration' } as never);
  await runMigrations(db, undefined, { mode: 'migrate' });

  const rows = (await getDb().all('SELECT name FROM schema_version ORDER BY version')) as Array<{ name: string }>;
  console.log(`\nMigrations recorded (${rows.length}):`);
  for (const r of rows) console.log('   ', r.name);
  await closeDb();
  console.log('\nOK — the migration path completes against this database.');
}

main().catch((err) => {
  console.error('\nMIGRATION FAILED:', err);
  process.exit(1);
});
