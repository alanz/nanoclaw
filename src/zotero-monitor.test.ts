import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  buildZoteroSyncPrompt,
  computeNextZoteroCheck,
  hasNewZoteroItems,
  ZoteroState,
  _resetZoteroMonitorLoopForTests,
} from './zotero-monitor.js';

const HOUR_MS = 3_600_000;

function makeState(overrides: Partial<ZoteroState> = {}): ZoteroState {
  return {
    lastVersion: 0,
    totalItems: 0,
    lastSync: null,
    nextCheck: new Date(Date.now() - 1000).toISOString(),
    scheduleType: 'interval',
    scheduleValue: String(HOUR_MS),
    ...overrides,
  };
}

beforeEach(() => {
  _resetZoteroMonitorLoopForTests();
});

// ── computeNextZoteroCheck ────────────────────────────────────────────────────

describe('computeNextZoteroCheck', () => {
  it('adds interval ms to the current next_check', () => {
    const base = new Date('2026-01-01T12:00:00.000Z');
    const state = makeState({
      scheduleType: 'interval',
      scheduleValue: String(HOUR_MS),
      nextCheck: base.toISOString(),
    });
    const next = computeNextZoteroCheck(state, new Date(base.getTime() + 1000));
    expect(next).toBe(new Date(base.getTime() + HOUR_MS).toISOString());
  });

  it('skips past missed intervals when significantly overdue', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    const state = makeState({
      scheduleType: 'interval',
      scheduleValue: String(HOUR_MS),
      nextCheck: base.toISOString(),
    });
    const now = new Date(base.getTime() + 5 * HOUR_MS + 1000);
    const next = computeNextZoteroCheck(state, now);
    expect(new Date(next).getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns a future date for a valid cron expression', () => {
    const state = makeState({
      scheduleType: 'cron',
      scheduleValue: '0 * * * *',
      nextCheck: new Date().toISOString(),
    });
    const next = computeNextZoteroCheck(state);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });

  it('handles null nextCheck by treating it as due now', () => {
    const state = makeState({ nextCheck: null });
    const next = computeNextZoteroCheck(state);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });
});

// ── hasNewZoteroItems ─────────────────────────────────────────────────────────

describe('hasNewZoteroItems', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when server version is higher than lastVersion', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: {
        get: (h: string) => (h === 'Last-Modified-Version' ? '3250' : null),
      },
    }));
    const result = await hasNewZoteroItems(3239);
    expect(result).toBe(true);
  });

  it('returns false when server version equals lastVersion', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: {
        get: (h: string) => (h === 'Last-Modified-Version' ? '3239' : null),
      },
    }));
    const result = await hasNewZoteroItems(3239);
    expect(result).toBe(false);
  });

  it('returns true (fail open) when the API call fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });
    const result = await hasNewZoteroItems(3239);
    expect(result).toBe(true);
  });

  it('returns true (fail open) when the API returns a non-OK status', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
    }));
    const result = await hasNewZoteroItems(3239);
    expect(result).toBe(true);
  });
});

// ── buildZoteroSyncPrompt ─────────────────────────────────────────────────────

describe('buildZoteroSyncPrompt', () => {
  it('includes the lastVersion in the command', () => {
    const prompt = buildZoteroSyncPrompt(3235, '/workspace/group/zotero-md');
    expect(prompt).toContain('--since 3235');
  });

  it('includes the outputDir in the command', () => {
    const prompt = buildZoteroSyncPrompt(0, '/workspace/group/zotero-md');
    expect(prompt).toContain('--output /workspace/group/zotero-md');
  });

  it('references the sync script path', () => {
    const prompt = buildZoteroSyncPrompt(0, '/workspace/group/zotero-md');
    expect(prompt).toContain('/workspace/tools/zotero-sync.mjs');
  });

  it('instructs agent to reply with nothing when no changes', () => {
    const prompt = buildZoteroSyncPrompt(0, '/workspace/group/zotero-md');
    expect(prompt).toContain('empty reply');
  });

  it('uses lastVersion 0 for first run', () => {
    const prompt = buildZoteroSyncPrompt(0, '/workspace/group/zotero-md');
    expect(prompt).toContain('--since 0');
  });
});
