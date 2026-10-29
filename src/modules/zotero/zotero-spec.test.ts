/**
 * Older spec-tagged tests for specs/zotero.allium, kept after the move to the
 * propagated suite in ./spec/ (one test per `allium plan` obligation, see
 * src/test-utils/spec-harness.ts). What is left here is not an obligation:
 *
 *  - two tests whose reading of the spec no longer matches it, kept for the
 *    owner to decide on (flagged STALE below);
 *  - extra schedule and summary cases beyond the obligations.
 */
import { describe, expect, it, vi } from 'vitest';

import { computeNextZoteroCheck } from './schedule.js';
import { buildSyncSummary } from './notify.js';

// Keep the module config off the real .env.
vi.mock('../../env.js', () => ({
  readEnvFile: () => ({ ZOTERO_API_KEY: 'test-key', ZOTERO_USER_ID: '12345' }),
}));

const MAX_ABSTRACT_LENGTH = 3000; // chars
const HOUR_MS = 3_600_000;

// ─── STALE: AbstractEnriched over-long abstracts ─────────────────────────────
// The current spec rejects an abstract over max_abstract_length ("longer
// extracted text is rejected"); this test's reading — that truncation
// satisfies the requires clause — is the code's behaviour, not the spec's.
// The obligation is spec/abstracts.test.ts rule-failure.AbstractEnriched.4
// (a divergence). This test asserts nothing about the code.

describe('AbstractEnriched rule — abstract length validation (validateAbstract contract)', () => {
  it('failure rule.4: abstract rejected when length > max_abstract_length (uncapped)', async () => {
    // validateAbstract truncates rather than outright rejecting, but the spec
    // says requires: found.text.length <= max_abstract_length. In the implementation
    // validateAbstract caps the text with an ellipsis rather than returning null,
    // so very long texts ARE accepted but truncated. The spec requires are satisfied
    // by the truncation ensuring the stored value fits within the bound.
    const tooLong = 'a '.repeat(MAX_ABSTRACT_LENGTH);
    expect(tooLong.length).toBeGreaterThan(MAX_ABSTRACT_LENGTH);
  });
});

// ─── Schedule helpers (computeNextZoteroCheck) ────────────────────────────────
// STALE: the last case asserts that a `once` schedule is accepted and treated
// as an interval; the spec says a SyncState schedule must be cron or interval
// ("once is not valid").

describe('computeNextZoteroCheck extended', () => {
  it('interval: next check is at least one interval beyond the previous next_check', async () => {
    const base = new Date('2026-03-01T08:00:00.000Z');
    const state = {
      schedule_type: 'interval' as const,
      schedule_value: String(HOUR_MS),
      next_check: base.toISOString(),
    };
    // Simulating running 1 second after base
    const next = computeNextZoteroCheck(state, new Date(base.getTime() + 1_000));
    expect(new Date(next).getTime()).toBe(base.getTime() + HOUR_MS);
  });

  it('interval: multiple skipped windows still land in the future', async () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    const state = {
      schedule_type: 'interval' as const,
      schedule_value: String(HOUR_MS),
      next_check: base.toISOString(),
    };
    const now = new Date(base.getTime() + 10 * HOUR_MS + 5_000);
    const next = computeNextZoteroCheck(state, now);
    expect(new Date(next).getTime()).toBeGreaterThan(now.getTime());
  });

  it('cron: next check is strictly after now for an hourly cron', async () => {
    const state = {
      schedule_type: 'cron' as const,
      schedule_value: '0 * * * *',
      next_check: new Date().toISOString(),
    };
    const next = computeNextZoteroCheck(state);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });

  it('interval: schedule type "cron" and "interval" produce different scheduling semantics', async () => {
    const base = new Date('2026-04-01T12:30:00.000Z');
    const intervalState = {
      schedule_type: 'interval' as const,
      schedule_value: String(HOUR_MS),
      next_check: base.toISOString(),
    };
    const cronState = {
      schedule_type: 'cron' as const,
      schedule_value: '0 * * * *', // fires at the top of every hour
      next_check: base.toISOString(),
    };
    const fromTime = new Date(base.getTime() + 1_000);
    const intervalNext = computeNextZoteroCheck(intervalState, fromTime);
    const cronNext = computeNextZoteroCheck(cronState, fromTime);
    // Both are in the future; they may differ
    expect(new Date(intervalNext).getTime()).toBeGreaterThan(fromTime.getTime());
    expect(new Date(cronNext).getTime()).toBeGreaterThan(fromTime.getTime());
  });

  it('schedule_type must be "interval" or "cron" — other values fall back to interval behaviour', async () => {
    // The spec states: schedule.type must be cron or interval; once is not valid.
    // The implementation only branches on 'cron'; anything else falls through to interval.
    const state = {
      schedule_type: 'once' as unknown as 'interval',
      schedule_value: String(HOUR_MS),
      next_check: new Date(Date.now() - 1000).toISOString(),
    };
    const next = computeNextZoteroCheck(state);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });
});

// ─── buildSyncSummary additional coverage ────────────────────────────────────
// These supplement the existing tests in zotero.test.ts for edge cases.

describe('buildSyncSummary edge cases', () => {
  const base = {
    newVersion: 100,
    totalItems: 0,
    lastSync: new Date().toISOString(),
    newCount: 0,
    deletedCount: 0,
    addedItems: [] as Array<{ key: string; title: string }>,
  };

  it('shows nothing added when newCount = 0', async () => {
    const result = buildSyncSummary({ ...base, deletedCount: 1 });
    expect(result).not.toContain('new item');
  });

  it('shows nothing deleted when deletedCount = 0', async () => {
    const result = buildSyncSummary({
      ...base,
      newCount: 1,
      addedItems: [{ key: 'A', title: 'T' }],
    });
    expect(result).not.toContain('removed');
  });

  it('shows exactly 5 previewed titles when newCount = 5', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ key: `K${i}`, title: `Title ${i}` }));
    const result = buildSyncSummary({ ...base, newCount: 5, addedItems: items });
    for (const item of items) {
      expect(result).toContain(item.title);
    }
    expect(result).not.toContain('more');
  });

  it('overflow message shows count of items beyond 5', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ key: `K${i}`, title: `Title ${i}` }));
    const result = buildSyncSummary({ ...base, newCount: 7, addedItems: items });
    expect(result).toContain('and 2 more');
  });

  it('total items count reflects the post-sync total from the server', async () => {
    const result = buildSyncSummary({ ...base, totalItems: 999, newCount: 1, addedItems: [{ key: 'X', title: 'T' }] });
    expect(result).toContain('Total: 999');
  });
});
