/**
 * Host-side obligations from specs/zotero.allium: SyncState and its schedule,
 * the pre-check rules, LibrarySynced as the monitor merges it, ChangesNotified
 * and the DigestEntry, the three enrichment triggers, and the SyncState
 * invariants.
 *
 * Everything runs through the real monitor (startZoteroMonitor, one tick at a
 * time), a real central DB (migrations), and real files in a temp groups
 * folder. The process boundary is faked: the Zotero API (`fetch`), the
 * channel adapter, and the host's child processes — each zotero-sync.mjs /
 * zotero-abstracts.mjs run is captured and answered by the test (for
 * LibrarySynced by running the real sync code; for the retry request by
 * running the real script with a zero budget, which looks nothing up).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, vi } from 'vitest';

interface Run {
  script: string;
  args: string[];
  env: Record<string, string | undefined>;
  timeout: number;
  done: boolean;
  finish(stdout: string, err?: Error): void;
}

const h = vi.hoisted(() => ({
  groups: '',
  env: {} as Record<string, string>,
  runs: [] as Run[],
  passthrough: false,
  delivered: [] as Array<{ channelType: string; platformId: string; content: string }>,
}));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  get GROUPS_DIR() {
    return h.groups;
  },
}));
vi.mock('../config.js', () => ({ ZOTERO_GROUP_FOLDER: 'lib', ZOTERO_POLL_INTERVAL: 3_600_000 }));
vi.mock('../../../env.js', () => ({
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.filter((k) => k in h.env).map((k) => [k, h.env[k]])),
}));
vi.mock('../../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: async (channelType: string, platformId: string, _thread: unknown, _kind: string, content: string) => {
      h.delivered.push({ channelType, platformId, content });
      return 'msg-1';
    },
  }),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  type Cb = (err: Error | null, stdout: string, stderr: string) => void;
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: { env: Record<string, string | undefined>; timeout: number },
      cb: Cb,
    ) => {
      const run: Run = {
        script: args[0].split('/').pop()!,
        args,
        env: opts.env,
        timeout: opts.timeout,
        done: false,
        finish(stdout, err) {
          if (run.done) return;
          run.done = true;
          cb(err ?? null, stdout, '');
        },
      };
      h.runs.push(run);
      if (h.passthrough) {
        // the real script, with no time to look anything up
        const real = args.map((a, i) => (args[i - 1] === '--budget-seconds' ? '0.001' : a));
        actual.execFile(cmd, real, opts, (err, stdout, stderr) => {
          run.done = true;
          cb(err, String(stdout), String(stderr));
        });
      }
      return {} as never;
    },
  };
});

import { getResource } from '../../../cli/crud.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../../db/messaging-groups.js';
import { runMigrations } from '../../../db/migrations/index.js';
import '../cli.js';
import { getZoteroSyncState, upsertZoteroSyncState, type ZoteroSyncState } from '../db.js';
import { _resetZoteroMonitorForTests, startZoteroMonitor } from '../monitor.js';
import { buildSyncSummary, notifySyncChanges } from '../notify.js';
import { fetchLibraryVersion } from '../pre-check.js';
import { ENRICHMENT_RUN_BUDGET_SECONDS, itemInBacklog, type ZoteroSyncResult } from '../sync.js';
import { obligation, divergence } from './harness.js';
import { itemFile, loadTool, type Frontmatter, type Sync } from './tools.js';

const fm = await loadTool<Frontmatter>('zotero-frontmatter.mjs');
const syncTool = await loadTool<Sync>('zotero-sync.mjs');

const AG = 'ag-lib';
const HOUR = 3_600_000;
const PRECHECK = 'https://api.zotero.org/users/42/items';
const SYNC_API = 'https://zotero.test';

/** What the fake Zotero API answers. */
const zotero = {
  /** Library version for the pre-check; an Error is a network failure, 'down' an HTTP 503. */
  version: 0 as number | Error | 'down',
  items: [] as Array<{ key: string; data: Record<string, unknown> }>,
  deleted: [] as string[],
  requests: [] as string[],
};

const mdDir = () => path.join(h.groups, 'lib', 'zotero-md');
const groupFile = (name: string) => path.join(h.groups, 'lib', name);
const writeItem = (key: string, text: string) => {
  fs.mkdirSync(mdDir(), { recursive: true });
  fs.writeFileSync(path.join(mdDir(), `${key}.md`), text);
};
const readItem = (key: string) => fs.readFileSync(path.join(mdDir(), `${key}.md`), 'utf-8');
const iso = (ms: number) => new Date(ms).toISOString();
const scriptRuns = (script: string) => h.runs.filter((r) => r.script === script);

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** One monitor tick: start the monitor and wait until it schedules the next one. */
async function tick(): Promise<void> {
  _resetZoteroMonitorForTests();
  const real = globalThis.setTimeout;
  let scheduled!: () => void;
  const next = new Promise<void>((r) => (scheduled = r));
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms === 30_000) {
      scheduled();
      return 0;
    }
    return (real as (...a: unknown[]) => unknown)(fn, ms, ...rest);
  }) as unknown as typeof setTimeout);
  startZoteroMonitor();
  await next;
  spy.mockRestore();
  await settle();
}

async function state(): Promise<ZoteroSyncState> {
  return (await getZoteroSyncState())!;
}

async function seedState(overrides: Partial<Omit<ZoteroSyncState, 'updated_at'>> = {}): Promise<void> {
  await upsertZoteroSyncState({
    agent_group_id: AG,
    last_version: 10,
    total_items: 0,
    last_sync: null,
    next_check: null,
    schedule_type: 'interval',
    schedule_value: String(HOUR),
    ...overrides,
  });
}

function writeSyncResult(result: Partial<ZoteroSyncResult>): ZoteroSyncResult {
  const full: ZoteroSyncResult = {
    newVersion: 12,
    totalItems: 5,
    lastSync: new Date().toISOString(),
    newCount: 0,
    deletedCount: 0,
    addedItems: [],
    ...result,
  };
  fs.mkdirSync(path.join(h.groups, 'lib'), { recursive: true });
  fs.writeFileSync(groupFile('zotero-state.json'), JSON.stringify(full));
  return full;
}

/** Answer every captured run that is still open, until none is left. */
async function drainRuns(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await settle();
    const open = h.runs.filter((r) => !r.done);
    if (open.length === 0) return;
    for (const r of open) r.finish('{}\n');
  }
}

beforeEach(async () => {
  h.groups = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-spec-monitor-')));
  h.env = { ZOTERO_API_KEY: 'zk', ZOTERO_USER_ID: '42' };
  h.runs = [];
  h.passthrough = false;
  h.delivered = [];
  Object.assign(zotero, { version: 0, items: [], deleted: [], requests: [] });
  vi.stubGlobal('fetch', async (url: string) => {
    zotero.requests.push(url);
    if (url.startsWith(PRECHECK)) {
      if (zotero.version instanceof Error) throw zotero.version;
      if (zotero.version === 'down') return new Response('', { status: 503 });
      return new Response('[]', { headers: { 'Last-Modified-Version': String(zotero.version) } });
    }
    const headers = { 'Last-Modified-Version': String(zotero.version) };
    if (url.startsWith(`${SYNC_API}/users/42/items?`)) return new Response(JSON.stringify(zotero.items), { headers });
    if (url.startsWith(`${SYNC_API}/users/42/deleted?`))
      return new Response(JSON.stringify({ items: zotero.deleted }), { headers });
    return new Response('', { status: 404 });
  });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Library', folder: 'lib', agent_provider: null, created_at: iso(Date.now()) });
});

afterEach(async () => {
  await drainRuns();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(h.groups, { recursive: true, force: true });
});

// ── SyncState ───────────────────────────────────────────────────────────────

obligation('entity-fields.SyncState', async () => {
  const before = Date.now();
  await tick(); // bootstrap
  const s = await state();
  expect(s).toMatchObject({
    agent_group_id: AG, // group
    last_version: 0,
    total_items: 0,
    last_sync: null,
    schedule_type: 'interval', // schedule
    schedule_value: String(HOUR),
  });
  expect(Date.parse(s.next_check!)).toBeGreaterThanOrEqual(before);

  await seedState({ last_version: 7, total_items: 3, last_sync: iso(before), next_check: iso(before + HOUR) });
  await seedState({ schedule_type: 'cron', schedule_value: '0 * * * *', next_check: iso(before) });
  expect(await state()).toMatchObject({ last_version: 10, schedule_type: 'cron', schedule_value: '0 * * * *' });
});

obligation('entity-optional.SyncState.last_sync', async () => {
  const t0 = Date.now() - 10 * 60_000;
  await seedState({ next_check: iso(t0 + HOUR) });
  expect((await state()).last_sync).toBeNull();
  const result = writeSyncResult({ lastSync: iso(t0 + 1000) });
  await tick();
  expect((await state()).last_sync).toBe(result.lastSync);
});

obligation('entity-optional.SyncState.next_check', async () => {
  await seedState({ next_check: null });
  expect((await state()).next_check).toBeNull();
  await tick();
  expect((await state()).next_check).not.toBeNull();
  // nothing is checked while it was null
  expect(zotero.requests).toEqual([]);
});

obligation('derived.SyncState.is_due', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const T = Date.parse('2026-10-29T09:00:00.000Z');
  vi.setSystemTime(T);
  zotero.version = 10;
  const due = async (nextCheck: string | null) => {
    await seedState({ next_check: nextCheck });
    zotero.requests = [];
    await tick();
    return zotero.requests.length > 0;
  };
  expect(await due(null)).toBe(false);
  expect(await due(iso(T + 1))).toBe(false);
  expect(await due(iso(T))).toBe(true); // next_check <= now, at the boundary
  expect(await due(iso(T - 60_000))).toBe(true);
});

// ── Config ──────────────────────────────────────────────────────────────────

obligation('config-default.default_sync_interval', async () => {
  vi.stubEnv('ZOTERO_POLL_INTERVAL', '');
  h.env = {};
  const real = await vi.importActual<typeof import('../config.js')>('../config.js');
  expect(real.ZOTERO_POLL_INTERVAL).toBe(HOUR);
});

obligation('config-default.pre_check_timeout', async () => {
  const timeouts: number[] = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeouts.push(ms);
    return real(ms);
  });
  zotero.version = 11;
  expect(await fetchLibraryVersion(10)).toBe(11);
  expect(timeouts).toEqual([10_000]);
});

obligation('config-default.abstract_retry_interval', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const retry = 180 * 86_400_000;
  const notFoundAt = (ms: number) => itemFile('K', { abstract_lookup: `${iso(now.getTime() - ms)} not_found` });
  // host (the monitor's backlog check) and the lookup run agree
  for (const inBacklog of [
    (t: string) => itemInBacklog(t, now),
    (t: string) => fm.inBacklog(fm.parseFrontMatter(t), now),
  ]) {
    expect(inBacklog(notFoundAt(retry - 1))).toBe(false);
    expect(inBacklog(notFoundAt(retry))).toBe(true);
  }
  expect(fm.RETRY_INTERVAL_DAYS).toBe(180);
});

obligation('config-default.enrichment_run_budget', async () => {
  expect(ENRICHMENT_RUN_BUDGET_SECONDS).toBe(25);
  writeItem('K', itemFile('K'));
  await seedState({ next_check: iso(Date.now() - 1000) });
  zotero.version = 10;
  await tick();
  const [run] = scriptRuns('zotero-abstracts.mjs');
  expect(run.args.slice(run.args.indexOf('--budget-seconds'), run.args.indexOf('--budget-seconds') + 2)).toEqual([
    '--budget-seconds',
    '25',
  ]);
  // the run's own time limit leaves room for the budget
  expect(run.timeout).toBeGreaterThan(25_000);
});

// ── Scheduling and the pre-check ────────────────────────────────────────────

obligation('rule-success.SyncStateInitialised', async () => {
  // first start: the row is created with next_check = now
  let before = Date.now();
  await tick();
  expect(Date.parse((await state()).next_check!)).toBeGreaterThanOrEqual(before);
  expect(Date.parse((await state()).next_check!)).toBeLessThanOrEqual(Date.now());

  // a row left with next_check = null gets next_check = now
  await seedState({ next_check: null, last_version: 42 });
  before = Date.now();
  await tick();
  const s = await state();
  expect(Date.parse(s.next_check!)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(s.next_check!)).toBeLessThanOrEqual(Date.now());
  expect(s.last_version).toBe(42);
});

obligation('rule-success.SyncCheckDue', async () => {
  zotero.version = 10;
  await seedState({ last_version: 10, next_check: iso(Date.now() - 1000) });
  await tick();
  expect(zotero.requests).toEqual([`${PRECHECK}?since=10&format=versions&limit=1`]);

  zotero.requests = [];
  await seedState({ last_version: 10, next_check: iso(Date.now() + 60_000) });
  await tick();
  expect(zotero.requests).toEqual([]);
});

obligation('rule-success.PreCheckFailed', async () => {
  const t0 = Date.now() - 10 * 60_000;
  for (const failure of [new Error('ECONNREFUSED'), 'down' as const, 'no credentials' as const]) {
    if (failure === 'no credentials') h.env = {};
    else zotero.version = failure;
    zotero.requests = [];
    await seedState({ last_version: 10, next_check: iso(t0) });
    await tick();
    const s = await state();
    expect(s.next_check, String(failure)).toBe(iso(t0 + HOUR));
    expect(s.last_version).toBe(10);
    expect(scriptRuns('zotero-sync.mjs')).toEqual([]);
  }
  // without credentials the API is not even asked
  expect(zotero.requests).toEqual([]);
});

obligation('rule-failure.PreCheckFailed.1', async () => {
  // A reachable API answers a version: the cycle is not skipped.
  zotero.version = 11;
  await seedState({ last_version: 10, next_check: iso(Date.now() - 1000) });
  await tick();
  expect(scriptRuns('zotero-sync.mjs')).toHaveLength(1);
});

obligation('rule-success.LibraryUnchanged', async () => {
  const t0 = Date.now() - 10 * 60_000;
  for (const version of [10, 9]) {
    zotero.version = version;
    await seedState({ last_version: 10, next_check: iso(t0) });
    await tick();
    expect(await state()).toMatchObject({ next_check: iso(t0 + HOUR), last_version: 10, last_sync: null });
  }
  expect(scriptRuns('zotero-sync.mjs')).toEqual([]);
});

obligation('rule-failure.LibraryUnchanged.1', async () => {
  zotero.version = 11;
  await seedState({ last_version: 10, next_check: iso(Date.now() - 1000) });
  await tick();
  // a newer version is a change, not "unchanged"
  expect(scriptRuns('zotero-sync.mjs')).toHaveLength(1);
});

obligation('rule-success.LibraryChanged', async () => {
  const t0 = Date.now() - 10 * 60_000;
  zotero.version = 15;
  await seedState({ last_version: 10, next_check: iso(t0) });
  await tick();
  const [run] = scriptRuns('zotero-sync.mjs');
  expect(run.args.slice(1)).toEqual(['--since', '10', '--output', mdDir(), '--state', groupFile('zotero-state.json')]);
  // the host process holds the credentials
  expect([run.env.ZOTERO_API_KEY, run.env.ZOTERO_USER_ID]).toEqual(['zk', '42']);
  // next_check is already advanced while the sync is still running
  expect(run.done).toBe(false);
  expect((await state()).next_check).toBe(iso(t0 + HOUR));
});

obligation('rule-failure.LibraryChanged.1', async () => {
  zotero.version = 10;
  await seedState({ last_version: 10, next_check: iso(Date.now() - 1000) });
  await tick();
  expect(scriptRuns('zotero-sync.mjs')).toEqual([]);
});

// ── LibrarySynced ───────────────────────────────────────────────────────────

obligation('rule-success.LibrarySynced', async () => {
  const t0 = Date.now() - 10 * 60_000;
  writeItem('OLD1', itemFile('OLD1'));
  writeItem(
    'OLD2',
    itemFile('OLD2', {}, 'An abstract that was already here before the sync ran, long enough to count.'),
  );
  await seedState({ last_version: 10, total_items: 2, next_check: iso(t0) });
  zotero.version = 12;
  zotero.items = [
    { key: 'NEW1', data: { title: 'New one', itemType: 'book', abstractNote: 'Zotero abstract.' } },
    { key: 'OLD2', data: { title: 'Old two, revised', itemType: 'book' } },
  ];
  zotero.deleted = ['OLD1'];

  await tick(); // LibraryChanged: the sync is started (behind the backlog pass OLD1 queued)
  for (const r of scriptRuns('zotero-abstracts.mjs')) r.finish('{}\n');
  await settle();
  const [run] = scriptRuns('zotero-sync.mjs');
  const arg = (flag: string) => run.args[run.args.indexOf(flag) + 1];
  const summary = await syncTool.syncLibrary({
    since: Number(arg('--since')),
    output: arg('--output'),
    stateFile: arg('--state'),
    apiBase: SYNC_API,
    userId: run.env.ZOTERO_USER_ID!,
    apiKey: run.env.ZOTERO_API_KEY!,
  });
  run.finish(`${JSON.stringify(summary)}\n`);
  await settle();

  await tick(); // the host merges the result
  const s = await state();
  const written = JSON.parse(fs.readFileSync(groupFile('zotero-state.json'), 'utf-8'));
  expect(s).toMatchObject({ last_version: 12, total_items: 2, last_sync: written.lastSync });
  // advanced again from the already-advanced next_check: two intervals in all
  expect(s.next_check).toBe(iso(t0 + 2 * HOUR));
  expect(fs.readdirSync(mdDir()).sort()).toEqual(['NEW1.md', 'OLD2.md']);
  // an upserted item is recreated from Zotero: no abstract, source or record carried over
  expect(fm.parseFrontMatter(readItem('OLD2'))!.meta.title).toBe('Old two, revised');
  expect(readItem('OLD2')).not.toContain('already here');
  expect(readItem('NEW1')).toContain('Zotero abstract.');
});

// ── ChangesNotified and the digest ──────────────────────────────────────────

async function wire(id: string, channelType: string, platformId: string): Promise<void> {
  const now = iso(Date.now());
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: id,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await createMessagingGroupAgent({
    id: `mga-${id}`,
    messaging_group_id: id,
    agent_group_id: AG,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
}

obligation('rule-success.ChangesNotified', async () => {
  await wire('mg-dc', 'deltachat', 'chat-1');
  await wire('mg-null', 'null', 'null-1');
  await seedState({ next_check: iso(Date.now() + HOUR) });
  const result = writeSyncResult({
    newCount: 2,
    deletedCount: 1,
    totalItems: 41,
    addedItems: [
      { key: 'A1', title: 'First paper' },
      { key: 'A2', title: 'Second paper' },
    ],
  });
  await tick();
  const summary = buildSyncSummary(result);
  expect(summary).toContain('2 new items');
  expect(summary).toContain('First paper');
  expect(summary).toContain('1 item removed');
  expect(summary).toContain('Total: 41 items');
  expect(h.delivered.sort((a, b) => a.platformId.localeCompare(b.platformId))).toEqual([
    { channelType: 'deltachat', platformId: 'chat-1', content: JSON.stringify({ text: summary }) },
    { channelType: 'null', platformId: 'null-1', content: JSON.stringify({ text: summary }) },
  ]);
  expect(fs.readFileSync(groupFile('zotero-digest.md'), 'utf-8')).toContain(summary);
});

obligation('rule-failure.ChangesNotified.1', async () => {
  await wire('mg-dc', 'deltachat', 'chat-1');
  await seedState({ next_check: iso(Date.now() + HOUR) });
  writeSyncResult({ newVersion: 13, newCount: 0, deletedCount: 0 });
  await tick();
  expect((await state()).last_version).toBe(13); // the sync was merged...
  expect(h.delivered).toEqual([]); // ...but nothing is announced
  expect(fs.existsSync(groupFile('zotero-digest.md'))).toBe(false);
});

obligation('rule-entity-creation.ChangesNotified.1', async () => {
  await seedState({ next_check: iso(Date.now() + HOUR) });
  const result = writeSyncResult({ newCount: 1, addedItems: [{ key: 'A1', title: 'Only paper' }] });
  const before = Date.now();
  await tick();
  const after = Date.now();
  // group: the entry is in this group's digest
  const digest = fs.readFileSync(groupFile('zotero-digest.md'), 'utf-8');
  const m = digest.match(/^\n\n## (\S+)\n\n([\s\S]*)$/);
  expect(m).not.toBeNull();
  // recorded_at: now
  expect(Date.parse(m![1])).toBeGreaterThanOrEqual(before);
  expect(Date.parse(m![1])).toBeLessThanOrEqual(after);
  expect(m![1]).toBe(iso(Date.parse(m![1])));
  // summary: the same summary the chat got
  expect(m![2]).toBe(buildSyncSummary(result));
});

obligation('entity-fields.DigestEntry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  fs.mkdirSync(path.join(h.groups, 'lib'), { recursive: true });
  const base = { newVersion: 1, totalItems: 3, lastSync: '', newCount: 0, deletedCount: 0, addedItems: [] };
  const first = { ...base, newCount: 1, addedItems: [{ key: 'A', title: 'Alpha' }] };
  const second = { ...base, deletedCount: 2 };
  vi.setSystemTime(Date.parse('2026-10-29T08:00:00.000Z'));
  await notifySyncChanges(AG, 'lib', first);
  vi.setSystemTime(Date.parse('2026-10-29T09:00:00.000Z'));
  await notifySyncChanges(AG, 'lib', second);
  // append-only, one block per entry: recorded_at heading, then the summary
  const entries = fs
    .readFileSync(groupFile('zotero-digest.md'), 'utf-8')
    .split(/\n\n## /)
    .filter(Boolean)
    .map((block) => {
      const [recordedAt, ...rest] = block.split('\n\n');
      return { recorded_at: recordedAt, summary: rest.join('\n\n') };
    });
  expect(entries).toEqual([
    { recorded_at: '2026-10-29T08:00:00.000Z', summary: buildSyncSummary(first) },
    { recorded_at: '2026-10-29T09:00:00.000Z', summary: buildSyncSummary(second) },
  ]);
});

// ── Enrichment triggers ─────────────────────────────────────────────────────

obligation('rule-success.EnrichmentBacklogScheduled', async () => {
  writeItem('K', itemFile('K'));
  await seedState({ next_check: iso(Date.now() - 1000) });
  zotero.version = new Error('offline'); // whatever the pre-check finds
  await tick();
  const runs = scriptRuns('zotero-abstracts.mjs');
  expect(runs).toHaveLength(1);
  expect(runs[0].args.slice(1, 3)).toEqual(['--dir', mdDir()]);
  expect(runs[0].args).not.toContain('--retry-not-found');
});

obligation('rule-failure.EnrichmentBacklogScheduled.1', async () => {
  const now = Date.now();
  writeItem('DONE', itemFile('DONE', {}, 'An abstract long enough to be one, written by an earlier enrichment run.'));
  writeItem('RECENT', itemFile('RECENT', { abstract_lookup: `${iso(now - 3 * 86_400_000)} not_found` }));
  await seedState({ next_check: iso(now - 1000) });
  zotero.version = 10;
  await tick();
  expect(scriptRuns('zotero-abstracts.mjs')).toEqual([]);
});

obligation('rule-success.EnrichmentTriggeredAfterSync', async () => {
  writeItem('A1', itemFile('A1'));
  await seedState({ next_check: iso(Date.now() + HOUR) }); // not a due check
  writeSyncResult({ newCount: 1, addedItems: [{ key: 'A1', title: 'Paper A1' }] });
  await tick();
  expect(scriptRuns('zotero-abstracts.mjs')).toHaveLength(1);
});

obligation('rule-failure.EnrichmentTriggeredAfterSync.1', async () => {
  writeItem('OLD', itemFile('OLD')); // backlog exists, but nothing was added
  await seedState({ next_check: iso(Date.now() + HOUR) });
  writeSyncResult({ newCount: 0, deletedCount: 1 });
  await tick();
  expect(scriptRuns('zotero-abstracts.mjs')).toEqual([]);
});

obligation('rule-failure.EnrichmentTriggeredAfterSync.2', async () => {
  writeItem('OLD', itemFile('OLD')); // backlog exists, but not among the added items
  writeItem('A1', itemFile('A1', {}, 'Zotero supplied this abstract, which is long enough to count as one.'));
  await seedState({ next_check: iso(Date.now() + HOUR) });
  writeSyncResult({ newCount: 1, addedItems: [{ key: 'A1', title: 'Paper A1' }] });
  await tick();
  expect(scriptRuns('zotero-abstracts.mjs')).toEqual([]);
});

divergence(
  'rule-success.EnrichmentTriggeredOnRequest',
  'retry-abstracts forgets only not_found records (forgetNotFound); an inconclusive record on an item without an abstract is kept',
  async () => {
    const now = Date.now();
    writeItem('NF', itemFile('NF', { abstract_lookup: `${iso(now - 3 * 86_400_000)} not_found` }));
    writeItem('INC', itemFile('INC', { abstract_lookup: `${iso(now - 86_400_000)} inconclusive` }));
    writeItem('DONE', itemFile('DONE', {}, 'An abstract long enough to be one, written by an earlier enrichment run.'));
    const done = readItem('DONE');
    h.passthrough = true;

    // `ncl zotero retry-abstracts`, as the main agent issues it
    const op = getResource('zotero')!.customOperations!['retry-abstracts'];
    const result = (await op.handler({}, { caller: 'host' })) as { backlog: number };

    const [run] = scriptRuns('zotero-abstracts.mjs');
    expect(run.args).toContain('--retry-not-found');
    expect(result.backlog).toBe(2); // EnrichmentRunRequested: a pass over both
    expect(readItem('DONE')).toBe(done);
    const lookup = (key: string) => fm.parseLookup(fm.parseFrontMatter(readItem(key))!.meta);
    expect(lookup('NF')).toBeNull();
    expect(lookup('INC'), 'every pending item forgets its lookup record').toBeNull();
  },
  20_000,
);

// ── Invariants ──────────────────────────────────────────────────────────────

obligation('invariant.SyncStateIsSingleton', async () => {
  const count = async () => (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM zotero_sync_state'))!.n;
  await tick(); // bootstrap
  await tick();
  expect(await count()).toBe(1);
  await createAgentGroup({ id: 'ag-2', name: 'Two', folder: 'two', agent_provider: null, created_at: iso(Date.now()) });
  await seedState({ agent_group_id: 'ag-2' });
  expect(await count()).toBe(1);
  await expect(
    getDb().run(`INSERT INTO zotero_sync_state (id, agent_group_id, updated_at) VALUES (2, ?, ?)`, AG, iso(Date.now())),
  ).rejects.toThrow();
  expect(await count()).toBe(1);
});

obligation('invariant.ActiveSyncStateHasNextCheck', async () => {
  const check = async (step: string) => {
    const s = await getZoteroSyncState();
    if (s?.last_sync != null) expect(s.next_check, step).not.toBeNull();
  };
  await tick();
  await check('bootstrap');
  await seedState({ next_check: iso(Date.now() - 1000) });
  zotero.version = new Error('offline');
  await tick();
  await check('pre-check failed');
  zotero.version = 11;
  await seedState({ next_check: iso(Date.now() - 1000) });
  await tick();
  await check('library changed');
  writeSyncResult({ newVersion: 11, lastSync: iso(Date.now()) });
  await tick();
  await check('sync merged');
  zotero.version = 11;
  await seedState({ ...(await state()), next_check: iso(Date.now() - 1000) });
  await tick();
  await check('library unchanged');
  // a sync result merged while next_check was unset still leaves one
  await seedState({ ...(await state()), next_check: null });
  writeSyncResult({ newVersion: 12, lastSync: iso(Date.now() + 5) });
  await tick();
  await check('sync merged over a null next_check');
});
