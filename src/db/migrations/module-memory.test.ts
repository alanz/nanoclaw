import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../index.js';
import { hasTable } from '../connection.js';
import { getRegisteredMigrations } from './index.js';
import './module-memory.js';

afterEach(async () => {
  await closeDb();
});

describe('module:memory migrations', () => {
  it('creates the old central ledger, then retires it: memory lives in each group index', async () => {
    const names = getRegisteredMigrations().map((m) => m.name);
    expect(names.indexOf('module:memory:retire-central-ledger')).toBeGreaterThan(names.indexOf('module:memory:index'));

    const db = await initTestDb();
    await runMigrations(db);
    expect(await hasTable(getDb(), 'memory_files')).toBe(false);
    expect(await hasTable(getDb(), 'memory_chunks')).toBe(false);
    const applied = (await getDb().all<{ name: string }>('SELECT name FROM schema_version')).map((r) => r.name);
    expect(applied).toEqual(expect.arrayContaining(['module:memory:index', 'module:memory:retire-central-ledger']));
  });
});
