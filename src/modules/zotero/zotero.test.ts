import { describe, it, expect, afterEach, vi } from 'vitest';

import { computeNextZoteroCheck } from './schedule.js';
import { fetchLibraryVersion } from './pre-check.js';
import { buildSyncSummary } from './notify.js';
import { readSyncResult } from './sync.js';
import type { ZoteroSyncState } from './db.js';

// ── computeNextZoteroCheck ────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

function makeState(
  overrides: Partial<Pick<ZoteroSyncState, 'schedule_type' | 'schedule_value' | 'next_check'>>,
): Pick<ZoteroSyncState, 'schedule_type' | 'schedule_value' | 'next_check'> {
  return {
    schedule_type: 'interval',
    schedule_value: String(HOUR_MS),
    next_check: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

describe('computeNextZoteroCheck', () => {
  it('adds one interval to the current next_check', () => {
    const base = new Date('2026-01-01T12:00:00.000Z');
    const state = makeState({
      schedule_type: 'interval',
      schedule_value: String(HOUR_MS),
      next_check: base.toISOString(),
    });
    const next = computeNextZoteroCheck(state, new Date(base.getTime() + 1000));
    expect(next).toBe(new Date(base.getTime() + HOUR_MS).toISOString());
  });

  it('skips missed intervals and lands in the future', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    const state = makeState({
      schedule_type: 'interval',
      schedule_value: String(HOUR_MS),
      next_check: base.toISOString(),
    });
    const now = new Date(base.getTime() + 5 * HOUR_MS + 1000);
    const next = computeNextZoteroCheck(state, now);
    expect(new Date(next).getTime()).toBeGreaterThan(now.getTime());
  });

  it('always returns a future date for cron schedule', () => {
    const state = makeState({
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      next_check: new Date().toISOString(),
    });
    const next = computeNextZoteroCheck(state);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });

  it('treats null next_check as if it were one interval ago', () => {
    const state = makeState({ next_check: null });
    const next = computeNextZoteroCheck(state);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });
});

// ── fetchLibraryVersion ───────────────────────────────────────────────────────

vi.mock('../../env.js', () => ({
  readEnvFile: () => ({ ZOTERO_API_KEY: 'test-key', ZOTERO_USER_ID: '12345' }),
}));

describe('fetchLibraryVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the server version when the library has changed', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'Last-Modified-Version' ? '3250' : null) },
    }));
    const version = await fetchLibraryVersion(3239);
    expect(version).toBe(3250);
  });

  it('returns the same version when the library is unchanged', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'Last-Modified-Version' ? '3239' : null) },
    }));
    const version = await fetchLibraryVersion(3239);
    expect(version).toBe(3239);
  });

  it('returns null (fail-closed) when the API returns a non-OK status', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
    }));
    const version = await fetchLibraryVersion(3239);
    expect(version).toBeNull();
  });

  it('returns null (fail-closed) when the fetch throws a network error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });
    const version = await fetchLibraryVersion(3239);
    expect(version).toBeNull();
  });
});

// ── buildSyncSummary ──────────────────────────────────────────────────────────

describe('buildSyncSummary', () => {
  const base = {
    newVersion: 1000,
    totalItems: 50,
    lastSync: new Date().toISOString(),
    newCount: 0,
    deletedCount: 0,
    addedItems: [],
  };

  it('reports new items with titles', () => {
    const result = buildSyncSummary({
      ...base,
      newCount: 2,
      addedItems: [
        { key: 'A', title: 'Paper One' },
        { key: 'B', title: 'Paper Two' },
      ],
    });
    expect(result).toContain('2 new items');
    expect(result).toContain('Paper One');
    expect(result).toContain('Paper Two');
  });

  it('caps the preview at 5 items and shows overflow count', () => {
    const addedItems = Array.from({ length: 8 }, (_, i) => ({
      key: `K${i}`,
      title: `Paper ${i}`,
    }));
    const result = buildSyncSummary({ ...base, newCount: 8, addedItems });
    expect(result).toContain('and 3 more');
  });

  it('uses singular for one new item', () => {
    const result = buildSyncSummary({
      ...base,
      newCount: 1,
      addedItems: [{ key: 'X', title: 'Solo' }],
    });
    expect(result).toContain('1 new item added');
    expect(result).not.toContain('1 new items');
  });

  it('reports deleted items', () => {
    const result = buildSyncSummary({ ...base, deletedCount: 3 });
    expect(result).toContain('3 items removed');
  });

  it('uses singular for one deleted item', () => {
    const result = buildSyncSummary({ ...base, deletedCount: 1 });
    expect(result).toContain('1 item removed');
    expect(result).not.toContain('1 items removed');
  });

  it('always includes total item count', () => {
    const result = buildSyncSummary({ ...base, newCount: 1, addedItems: [{ key: 'X', title: 'T' }] });
    expect(result).toContain('Total: 50');
  });
});

// ── readSyncResult ────────────────────────────────────────────────────────────

import fs from 'fs';

describe('readSyncResult', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON when the state file exists', () => {
    const payload = {
      newVersion: 999,
      totalItems: 10,
      lastSync: '2026-01-01T00:00:00Z',
      newCount: 2,
      deletedCount: 0,
      addedItems: [{ key: 'X', title: 'T' }],
    };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(payload));
    const result = readSyncResult('any-folder');
    expect(result).toMatchObject({ newVersion: 999, newCount: 2 });
  });

  it('returns null when the state file does not exist', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = readSyncResult('nonexistent-folder');
    expect(result).toBeNull();
  });
});
