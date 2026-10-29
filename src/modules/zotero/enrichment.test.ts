/**
 * Abstract enrichment backlog and its runs (specs/zotero.allium
 * EnrichmentBacklogScheduled, EnrichmentTriggeredAfterSync, EnrichmentRun),
 * against a real central DB and real session folders.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-zotero-enrichment';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-zotero-enrichment/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-zotero-enrichment/groups',
  };
});

// The host runs the Zotero scripts as child processes: capture each run, and
// answer it as the script would.
const runs = vi.hoisted(
  () =>
    [] as Array<{
      args: string[];
      env: Record<string, string | undefined>;
      finish: (stdout: string, err?: Error) => void;
    }>,
);
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (
    _cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined> },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    runs.push({ args, env: opts.env, finish: (stdout, err) => cb(err ?? null, stdout, '') });
  },
}));
vi.mock('../../env.js', () => ({
  readEnvFile: () => ({ ZOTERO_API_KEY: 'zk', ZOTERO_USER_ID: '42' }),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import {
  ENRICHMENT_RUN_BUDGET_SECONDS,
  enrichmentBacklog,
  itemInBacklog,
  runEnrichment,
  runSync,
  zoteroScriptBusy,
} from './sync.js';

const AG = 'ag-zotero';
const FOLDER = 'zot';
const MD_DIR = path.join(TEST_ROOT, 'groups', FOLDER, 'zotero-md');
const NOW = new Date('2026-10-11T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const ABSTRACT = 'A'.repeat(120);

function item(lookup?: string, abstract?: string): string {
  const fm = ['title: T', 'zoteroKey: K', ...(lookup ? [`abstract_lookup: ${lookup}`] : [])].join('\n');
  return `---\n${fm}\n---\n# T\n\n**Author (2020)**\n${abstract ? `\n${abstract}\n` : ''}`;
}

/** An item with neither authors nor a year: no author/year line (buildMarkdown). */
function bareItem(abstract?: string): string {
  return `---\ntitle: T\nitemType: webpage\nzoteroKey: K\n---\n# T\n${abstract ? `\n${abstract}\n` : ''}`;
}

function writeItem(key: string, text: string): void {
  fs.mkdirSync(MD_DIR, { recursive: true });
  fs.writeFileSync(path.join(MD_DIR, `${key}.md`), text);
}

/** Let the queued run start (it chains behind any earlier one). */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Zotero',
    folder: FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('itemInBacklog', () => {
  it('includes an item without an abstract or lookup record', () => {
    expect(itemInBacklog(item(), NOW)).toBe(true);
  });

  it('excludes an item with an abstract', () => {
    expect(itemInBacklog(item(undefined, ABSTRACT), NOW)).toBe(false);
  });

  it('sees the abstract of an item with no author/year line', () => {
    expect(itemInBacklog(bareItem(ABSTRACT), NOW)).toBe(false);
    expect(itemInBacklog(bareItem(), NOW)).toBe(true);
  });

  it('excludes a not_found lookup within the retry interval, and includes one past it', () => {
    expect(itemInBacklog(item(`${daysAgo(179)} not_found`), NOW)).toBe(false);
    expect(itemInBacklog(item(`${daysAgo(181)} not_found`), NOW)).toBe(true);
  });

  it('keeps inconclusive lookups in the backlog', () => {
    expect(itemInBacklog(item(`${daysAgo(0)} inconclusive`), NOW)).toBe(true);
  });

  it('ignores a file without frontmatter', () => {
    expect(itemInBacklog('# just text\n', NOW)).toBe(false);
  });
});

describe('enrichmentBacklog', () => {
  it('lists backlog keys, optionally only among given keys', () => {
    writeItem('NEW', item());
    writeItem('DONE', item(undefined, ABSTRACT));
    writeItem('RECENT', item(`${daysAgo(3)} not_found`));
    writeItem('RETRY', item(`${daysAgo(3)} inconclusive`));
    expect(enrichmentBacklog(FOLDER, NOW).sort()).toEqual(['NEW', 'RETRY']);
    expect(enrichmentBacklog(FOLDER, NOW, ['DONE', 'NEW', 'MISSING'])).toEqual(['NEW']);
  });

  it('is empty when the folder does not exist', () => {
    expect(enrichmentBacklog('no-such-folder', NOW)).toEqual([]);
  });
});

describe('host runs (zotero.allium: sync and enrichment are host processes)', () => {
  it('an enrichment pass runs zotero-abstracts.mjs on the group folder, budgeted, with the key', async () => {
    runs.length = 0;
    const done = runEnrichment(FOLDER);
    await tick();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(path.basename(run.args[0])).toBe('zotero-abstracts.mjs');
    expect(run.args.slice(1)).toEqual(['--dir', MD_DIR, '--budget-seconds', String(ENRICHMENT_RUN_BUDGET_SECONDS)]);
    expect([run.env.ZOTERO_API_KEY, run.env.ZOTERO_USER_ID]).toEqual(['zk', '42']);
    run.finish('{"backlog":3,"enriched":1}\n');
    expect(await done).toEqual({ backlog: 3, enriched: 1 });
  });

  it('a retry on request forgets not_found records first', async () => {
    runs.length = 0;
    const done = runEnrichment(FOLDER, { retryNotFound: true });
    await tick();
    expect(runs[0].args).toContain('--retry-not-found');
    runs[0].finish('{}\n');
    await done;
  });

  it('a sync writes into the group folder and its state file there', async () => {
    runs.length = 0;
    const done = runSync(FOLDER, 3301);
    await tick();
    const groupDir = path.join(TEST_ROOT, 'groups', FOLDER);
    expect(path.basename(runs[0].args[0])).toBe('zotero-sync.mjs');
    expect(runs[0].args.slice(1)).toEqual([
      '--since',
      '3301',
      '--output',
      path.join(groupDir, 'zotero-md'),
      '--state',
      path.join(groupDir, 'zotero-state.json'),
    ]);
    expect(fs.existsSync(path.join(groupDir, 'zotero-md'))).toBe(true);
    runs[0].finish('{"newCount":0}\n');
    await done;
  });

  it('one script at a time: a second waits for the first', async () => {
    runs.length = 0;
    const first = runEnrichment(FOLDER);
    const second = runSync(FOLDER, 1);
    await tick();
    expect(runs).toHaveLength(1);
    expect(zoteroScriptBusy()).toBe(true);
    runs[0].finish('{}\n');
    await first;
    await tick();
    expect(runs).toHaveLength(2);
    runs[1].finish('{}\n');
    await second;
    expect(zoteroScriptBusy()).toBe(false);
  });

  it('a failed run resolves to null rather than throwing', async () => {
    runs.length = 0;
    const done = runEnrichment(FOLDER);
    await tick();
    runs[0].finish('', new Error('exit 1'));
    expect(await done).toBeNull();
  });
});
