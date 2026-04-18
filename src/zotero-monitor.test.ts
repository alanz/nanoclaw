import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';

import {
  buildZoteroSyncPrompt,
  computeNextZoteroCheck,
  hasNewZoteroItems,
  runZoteroSync,
  ZoteroState,
  _resetZoteroMonitorLoopForTests,
} from './zotero-monitor.js';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('./config.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ZOTERO_GROUP_FOLDER: 'zotero-test',
    ZOTERO_CHAT_JID: 'zotero@g.us',
  };
});

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

  it('returns false (fail closed) when the API call fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network error');
    });
    const result = await hasNewZoteroItems(3239);
    expect(result).toBe(false);
  });

  it('returns false (fail closed) when the API returns a non-OK status', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
    }));
    const result = await hasNewZoteroItems(3239);
    expect(result).toBe(false);
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

// ── runZoteroSync sender ──────────────────────────────────────────────────────

describe('runZoteroSync sender', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'appendFileSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('passes Zotero as sender when forwarding sync result', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      headers: {
        get: (h: string) => (h === 'Last-Modified-Version' ? '9999' : null),
      },
    }));

    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _opts, _onProcess, onOutput) => {
        await onOutput!({ result: 'zotero summary', status: 'success' });
        return { result: 'zotero summary', status: 'success' } as any;
      },
    );

    const sendMessage = vi.fn(async () => {});

    await runZoteroSync({
      registeredGroups: () => ({
        'zotero-test': {
          name: 'Zotero',
          folder: 'zotero-test',
          trigger: '',
          added_at: '',
        },
      }),
      queue: {
        enqueueTask: vi.fn(),
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: vi.fn(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'zotero@g.us',
      'zotero summary',
      'Zotero',
    );
  });
});
