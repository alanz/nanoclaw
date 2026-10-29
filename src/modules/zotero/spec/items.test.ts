/**
 * Item obligations from specs/zotero.allium: the ZoteroLibrary / ZoteroItem
 * external entities as the sync reads them, the ItemFile it writes, the
 * sync's request timeout, and UniqueItemFilesPerGroup.
 *
 * The sync is container/tools/zotero-sync.mjs (run by the host as a child
 * process); syncLibrary is called directly against a temp zotero-md folder,
 * with the Zotero web API faked through `fetch`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { obligation } from './harness.js';
import { loadTool, type Frontmatter, type Sync } from './tools.js';

const fm = await loadTool<Frontmatter>('zotero-frontmatter.mjs');
const sync = await loadTool<Sync>('zotero-sync.mjs');

const API = 'https://zotero.test';
const BASE = `${API}/users/42`;

interface ZItem {
  key: string;
  data: Record<string, unknown>;
}

/** The Zotero library as the fake API serves it. */
const library = {
  version: 0,
  items: [] as ZItem[],
  /** Items changed since a version (the fake ignores `since` and serves `items`). */
  deleted: [] as string[],
};

let root: string;

function stubZotero(): void {
  vi.stubGlobal('fetch', async (url: string) => {
    const headers = { 'Last-Modified-Version': String(library.version) };
    if (url.startsWith(`${BASE}/items?`)) {
      const start = Number(new URL(url).searchParams.get('start') ?? 0);
      return new Response(JSON.stringify(library.items.slice(start, start + 100)), { headers });
    }
    if (url.startsWith(`${BASE}/deleted?`))
      return new Response(JSON.stringify({ items: library.deleted }), { headers });
    return new Response('not found', { status: 404 });
  });
}

function runSync(group: string, since: number) {
  return sync.syncLibrary({
    since,
    output: path.join(root, group, 'zotero-md'),
    stateFile: path.join(root, group, 'zotero-state.json'),
    apiBase: API,
    userId: '42',
    apiKey: 'zk',
  });
}

function itemText(group: string, key: string): string {
  return fs.readFileSync(path.join(root, group, 'zotero-md', `${key}.md`), 'utf-8');
}

function parsed(group: string, key: string) {
  return fm.parseFrontMatter(itemText(group, key))!;
}

const ABSTRACT = 'We study how specifications and tests propagate across a codebase, and report what we found.';

function zitem(key: string, data: Record<string, unknown> = {}): ZItem {
  return { key, data: { title: `Paper ${key}`, itemType: 'journalArticle', ...data } };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-spec-items-'));
  library.version = 10;
  library.items = [];
  library.deleted = [];
  stubZotero();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

obligation('entity-fields.ZoteroLibrary', async () => {
  // version: the library's Last-Modified-Version, recorded as the synced version
  library.version = 3301;
  library.items = [zitem('AAAA1111')];
  const result = await runSync('lib', 0);
  expect(result.newVersion).toBe(3301);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'lib', 'zotero-state.json'), 'utf-8'));
  expect(state.newVersion).toBe(3301);
});

obligation('entity-fields.ZoteroItem', async () => {
  library.items = [
    zitem('224KRICZ', {
      title: 'Propagating tests from specifications',
      creators: [
        { creatorType: 'author', lastName: 'Doe', firstName: 'Jane' },
        { creatorType: 'author', lastName: 'Roe', firstName: 'Rick' },
        { creatorType: 'editor', lastName: 'Ed', firstName: 'Itor' },
      ],
      date: '2021-03-04',
      DOI: '10.1000/xyz',
      url: 'https://example.org/paper',
      itemType: 'conferencePaper',
      tags: [{ tag: 'testing' }, { tag: 'specs' }],
      abstractNote: ABSTRACT,
    }),
  ];
  await runSync('lib', 0);
  const { meta, body } = parsed('lib', '224KRICZ');
  expect(meta).toEqual({
    title: 'Propagating tests from specifications',
    authors: 'Doe, Jane; Roe, Rick',
    year: '2021',
    doi: '10.1000/xyz',
    url: 'https://example.org/paper',
    itemType: 'conferencePaper',
    zoteroKey: '224KRICZ',
    tags: 'testing, specs',
  });
  expect(body).toBe(`\n# Propagating tests from specifications\n\n**Doe, Jane; Roe, Rick (2021)**\n\n${ABSTRACT}\n`);
});

obligation('entity-optional.ZoteroItem.year', async () => {
  library.items = [zitem('NOYEAR01'), zitem('YEAR0001', { date: 'March 2019' })];
  await runSync('lib', 0);
  expect(parsed('lib', 'NOYEAR01').meta.year).toBeUndefined();
  expect(parsed('lib', 'YEAR0001').meta.year).toBe('2019');
  expect(parsed('lib', 'YEAR0001').body).toContain('**2019**');
});

obligation('entity-optional.ZoteroItem.doi', async () => {
  library.items = [zitem('NODOI001'), zitem('DOI00001', { DOI: '10.1000/abc' })];
  await runSync('lib', 0);
  expect(parsed('lib', 'NODOI001').meta.doi).toBeUndefined();
  expect(parsed('lib', 'DOI00001').meta.doi).toBe('10.1000/abc');
});

obligation('entity-optional.ZoteroItem.url', async () => {
  library.items = [zitem('NOURL001'), zitem('URL00001', { url: 'https://arxiv.org/abs/2101.00001' })];
  await runSync('lib', 0);
  expect(parsed('lib', 'NOURL001').meta.url).toBeUndefined();
  expect(parsed('lib', 'URL00001').meta.url).toBe('https://arxiv.org/abs/2101.00001');
});

obligation('entity-optional.ZoteroItem.abstract', async () => {
  const by = { creators: [{ creatorType: 'author', lastName: 'Doe', firstName: 'Jane' }] };
  library.items = [zitem('NOABS001', by), zitem('ABS00001', { ...by, abstractNote: ABSTRACT })];
  await runSync('lib', 0);
  expect(fm.hasAbstract(parsed('lib', 'NOABS001').body)).toBe(false);
  expect(itemText('lib', 'NOABS001')).not.toContain(ABSTRACT);
  expect(fm.hasAbstract(parsed('lib', 'ABS00001').body)).toBe(true);
  expect(parsed('lib', 'ABS00001').body.trimEnd().endsWith(ABSTRACT)).toBe(true);
});

obligation('entity-fields.ItemFile', async () => {
  library.items = [zitem('K1', { title: 'One', abstractNote: ABSTRACT }), zitem('K2', { title: 'Two' })];
  await runSync('lib', 0);
  // group: the item files live in that group's own zotero-md folder
  expect(fs.readdirSync(path.join(root, 'lib', 'zotero-md')).sort()).toEqual(['K1.md', 'K2.md']);
  const one = parsed('lib', 'K1');
  // item_key: the filename stem and zoteroKey
  expect(one.meta.zoteroKey).toBe('K1');
  // title: frontmatter and H1
  expect(one.meta.title).toBe('One');
  expect(one.body.split('\n').find((l) => l.trim())).toBe('# One');
  // abstract: the body after the heading
  expect(one.body).toContain(ABSTRACT);
  // abstract_source and the lookup record are unset on creation
  expect(one.meta.abstract_source).toBeUndefined();
  expect(fm.parseLookup(one.meta)).toBeNull();
});

obligation('entity-optional.ItemFile.abstract', async () => {
  const isSet = (key: string) => fm.hasAbstract(parsed('lib', key).body);
  library.items = [
    zitem('K1', { creators: [{ creatorType: 'author', lastName: 'Doe', firstName: 'Jane' }], date: '2020' }),
    zitem('K2', {
      creators: [{ creatorType: 'author', lastName: 'Doe', firstName: 'Jane' }],
      abstractNote: ABSTRACT,
    }),
    zitem('BARE', { itemType: 'webpage', abstractNote: ABSTRACT }),
  ];
  await runSync('lib', 0);
  // null, then set by enrichment
  expect(isSet('K1')).toBe(false);
  const file = path.join(root, 'lib', 'zotero-md', 'K1.md');
  fs.writeFileSync(file, fm.applyAbstract(itemText('lib', 'K1'), ABSTRACT, 's2_doi'));
  expect(isSet('K1')).toBe(true);
  // set from Zotero
  expect(isSet('K2')).toBe(true);
  // set from Zotero, on an item with no authors and no year
  expect(isSet('BARE'), 'BARE has an abstract from Zotero').toBe(true);
});

obligation('config-default.sync_request_timeout', async () => {
  const timeouts: number[] = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeouts.push(ms);
    return real(ms);
  });
  library.items = [zitem('K1')];
  library.deleted = ['GONE0001'];
  await runSync('lib', 5);
  // one items page and the deletions, each with the 30 s limit
  expect(timeouts).toEqual([30_000, 30_000]);
});

obligation('invariant.UniqueItemFilesPerGroup', async () => {
  const keysIn = (group: string) =>
    fs
      .readdirSync(path.join(root, group, 'zotero-md'))
      .map((f) => parsed(group, f.slice(0, -3)).meta.zoteroKey)
      .sort();
  const check = (group: string) => {
    const keys = keysIn(group);
    expect(new Set(keys).size, `${group}: ${keys}`).toBe(keys.length);
  };

  library.items = [zitem('A'), zitem('B')];
  await runSync('lib', 0);
  check('lib');

  // A modified, C new, B deleted: still one file per key
  library.version = 11;
  library.items = [zitem('A', { title: 'A revised' }), zitem('C')];
  library.deleted = ['B'];
  await runSync('lib', 10);
  check('lib');
  expect(keysIn('lib')).toEqual(['A', 'C']);
  expect(parsed('lib', 'A').meta.title).toBe('A revised');

  // the same key in another group is a different item file
  library.items = [zitem('A')];
  library.deleted = [];
  await runSync('other', 0);
  check('other');
  expect(keysIn('other')).toEqual(['A']);
  expect(parsed('lib', 'A').meta.title).toBe('A revised');
});
