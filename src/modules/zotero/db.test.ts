import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getZoteroSyncState, updateAfterSync, updateNextCheck, upsertZoteroSyncState } from './db.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-lib',
    name: 'Library',
    folder: 'lib',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
});

// CLAUDE.md "Timestamps": stored from JS as toISOString(), never datetime('now'),
// whose naive "YYYY-MM-DD HH:MM:SS" new Date() reads as local time.
describe('zotero_sync_state.updated_at', () => {
  it('is ISO-8601 UTC after each kind of write', async () => {
    await upsertZoteroSyncState({
      agent_group_id: 'ag-lib',
      last_version: 0,
      total_items: 0,
      last_sync: null,
      next_check: null,
      schedule_type: 'interval',
      schedule_value: '3600000',
    });
    expect((await getZoteroSyncState())!.updated_at).toMatch(ISO_UTC);

    await updateNextCheck(new Date().toISOString());
    expect((await getZoteroSyncState())!.updated_at).toMatch(ISO_UTC);

    await updateAfterSync(5, 3, new Date().toISOString(), new Date().toISOString());
    expect((await getZoteroSyncState())!.updated_at).toMatch(ISO_UTC);
  });
});
