import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIN_ABSTRACT,
  MAX_ABSTRACT,
  parseFrontMatter,
  insertAbstract,
  addFrontMatterField,
  validateAbstract,
  setFrontMatterField,
  removeFrontMatterField,
  parseLookup,
  recordLookup,
  applyAbstract,
  inBacklog,
  prioritiseBacklog,
} from './zotero-frontmatter.mjs';
import { fetchWithRetry, OutOfBudget } from './zotero-enrich.mjs';
import { forgetNotFound, runBacklogPass } from './zotero-abstracts.mjs';
import { backoffFromResponse } from './zotero-extract-abstracts.mjs';
import { syncLibrary } from './zotero-sync.mjs';

const FM = `---
title: Test Paper
doi: 10.1234/test
---
`;
const FM_WITH_BODY = `---
title: Test Paper
---
Some body text here.
`;

// ── parseFrontMatter ──────────────────────────────────────────────────────────

describe('parseFrontMatter', () => {
  it('returns null when no frontmatter block is present', () => {
    assert.equal(parseFrontMatter('Just plain text\nno frontmatter'), null);
  });

  it('returns null when opening --- has no closing ---', () => {
    assert.equal(parseFrontMatter('---\ntitle: Test\n'), null);
  });

  it('parses key-value pairs into meta', () => {
    const result = parseFrontMatter(FM);
    assert.deepEqual(result?.meta, { title: 'Test Paper', doi: '10.1234/test' });
  });

  it('returns the body after the closing ---', () => {
    const result = parseFrontMatter(FM_WITH_BODY);
    assert.equal(result?.body, 'Some body text here.\n');
  });

  it('returns empty body when nothing follows the frontmatter', () => {
    const result = parseFrontMatter(FM);
    assert.equal(result?.body, '');
  });
});

// ── insertAbstract ────────────────────────────────────────────────────────────

describe('insertAbstract', () => {
  it('appends the abstract separated by a blank line', () => {
    const result = insertAbstract(FM, 'This is the abstract.');
    assert.ok(result.endsWith('\n\nThis is the abstract.\n'));
  });

  it('trims trailing whitespace from the original text before appending', () => {
    const result = insertAbstract(FM + '   ', 'Abstract text.');
    assert.ok(!result.includes('   \n\n'));
  });

  it('trims leading/trailing whitespace from the abstract', () => {
    const result = insertAbstract(FM, '  Abstract text.  ');
    assert.ok(result.endsWith('\n\nAbstract text.\n'));
  });
});

// ── addFrontMatterField ───────────────────────────────────────────────────────

describe('addFrontMatterField', () => {
  it('inserts the field before the closing ---', () => {
    const result = addFrontMatterField(FM, 'abstract_source', 's2_doi');
    assert.ok(result.includes('\nabstract_source: s2_doi\n---'));
  });

  it('does not disturb existing fields', () => {
    const result = addFrontMatterField(FM, 'abstract_source', 'cr_title');
    assert.ok(result.includes('title: Test Paper'));
    assert.ok(result.includes('doi: 10.1234/test'));
  });

  it('returns the text unchanged when there is no frontmatter', () => {
    const plain = 'No frontmatter here.';
    assert.equal(addFrontMatterField(plain, 'k', 'v'), plain);
  });

  it('returns the text unchanged when the opening --- has no closing ---', () => {
    const broken = '---\ntitle: Test\n';
    assert.equal(addFrontMatterField(broken, 'k', 'v'), broken);
  });
});

// ── validateAbstract ──────────────────────────────────────────────────────────

describe('validateAbstract', () => {
  it('returns null for null input', () => {
    assert.equal(validateAbstract(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(validateAbstract(''), null);
  });

  it(`returns null for text shorter than ${MIN_ABSTRACT} chars`, () => {
    assert.equal(validateAbstract('a'.repeat(MIN_ABSTRACT - 1)), null);
  });

  it(`accepts text at exactly ${MIN_ABSTRACT} chars`, () => {
    const text = 'a'.repeat(MIN_ABSTRACT);
    assert.equal(validateAbstract(text), text);
  });

  it('passes through text within bounds unchanged', () => {
    const text = 'a'.repeat(500);
    assert.equal(validateAbstract(text), text);
  });

  it(`truncates text longer than ${MAX_ABSTRACT} chars and appends ellipsis`, () => {
    const text = 'a'.repeat(MAX_ABSTRACT + 100);
    const result = validateAbstract(text);
    assert.ok(result !== null);
    assert.ok(result.endsWith('…'));
    assert.ok(result.length <= MAX_ABSTRACT + 1); // +1 for the ellipsis char
  });

  it('truncates at a word boundary, not mid-word', () => {
    // Build a string of exactly MAX_ABSTRACT+1 chars that ends with a full word
    const word = 'overflow';
    const padding = 'x '.repeat(Math.floor((MAX_ABSTRACT - word.length) / 2));
    const text = (padding + word + ' ').slice(0, MAX_ABSTRACT + 50);
    const result = validateAbstract(text);
    assert.ok(result !== null);
    assert.ok(!result.slice(0, -1).endsWith(' ')); // no trailing space before ellipsis
  });
});

// ── Lookup records and the backlog (zotero.allium EnrichmentRun) ─────────────


const ABSTRACT = 'A'.repeat(120);
const NOW = new Date('2026-10-11T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function item(fields, body = '# Title\n\nAuthor (2020)\n') {
  return `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
}

describe('setFrontMatterField / removeFrontMatterField', () => {
  it('replaces an existing field instead of adding a second one', () => {
    const out = setFrontMatterField(item({ title: 'T', abstract_lookup: 'x' }), 'abstract_lookup', 'y');
    assert.equal(parseFrontMatter(out).meta.abstract_lookup, 'y');
    assert.equal(out.match(/abstract_lookup:/g).length, 1);
  });

  it('removes only frontmatter lines, never body text', () => {
    const text = item({ title: 'T', abstract_lookup: 'x' }, 'abstract_lookup: in body\n');
    const out = removeFrontMatterField(text, 'abstract_lookup');
    assert.equal(parseFrontMatter(out).meta.abstract_lookup, undefined);
    assert.ok(out.includes('abstract_lookup: in body'));
  });
});

describe('parseLookup / recordLookup', () => {
  it('round-trips a record', () => {
    const out = recordLookup(item({ title: 'T' }), NOW, 'not_found');
    assert.deepEqual(parseLookup(parseFrontMatter(out).meta), { at: NOW.toISOString(), result: 'not_found' });
  });

  it('ignores malformed records', () => {
    assert.equal(parseLookup({ abstract_lookup: 'soon not_found' }), null);
    assert.equal(parseLookup({ abstract_lookup: `${NOW.toISOString()} maybe` }), null);
    assert.equal(parseLookup({}), null);
  });
});

describe('applyAbstract', () => {
  it('inserts the abstract and source and drops the lookup record', () => {
    const text = recordLookup(item({ title: 'T' }), NOW, 'inconclusive');
    const out = parseFrontMatter(applyAbstract(text, ABSTRACT, 's2_doi'));
    assert.equal(out.meta.abstract_source, 's2_doi');
    assert.equal(out.meta.abstract_lookup, undefined);
    assert.ok(out.body.includes(ABSTRACT));
  });
});

describe('inBacklog', () => {
  const parse = (fields, body) => parseFrontMatter(item(fields, body));
  it('includes an item never looked up', () => assert.equal(inBacklog(parse({ title: 'T' }), NOW), true));
  it('excludes an item that has an abstract', () =>
    assert.equal(inBacklog(parse({ title: 'T' }, `# T\n\nA (2020)\n\n${ABSTRACT}\n`), NOW), false));
  it('excludes a recent not_found', () =>
    assert.equal(inBacklog(parse({ abstract_lookup: `${daysAgo(10)} not_found` }), NOW), false));
  it('includes a not_found older than the retry interval', () =>
    assert.equal(inBacklog(parse({ abstract_lookup: `${daysAgo(181)} not_found` }), NOW), true));
  it('includes a recent inconclusive', () =>
    assert.equal(inBacklog(parse({ abstract_lookup: `${daysAgo(0)} inconclusive` }), NOW), true));
});

describe('prioritiseBacklog', () => {
  it('orders never-tried (identifiers first), then inconclusive, then expired not_found, oldest first', () => {
    const e = (name, meta) => ({ name, meta });
    const order = prioritiseBacklog([
      e('expired', { abstract_lookup: `${daysAgo(200)} not_found` }),
      e('inconclusive-new', { abstract_lookup: `${daysAgo(1)} inconclusive` }),
      e('title-only', { title: 'T' }),
      e('inconclusive-old', { abstract_lookup: `${daysAgo(5)} inconclusive` }),
      e('arxiv', { url: 'https://arxiv.org/abs/2101.00001' }),
      e('doi', { doi: '10.1/x' }),
    ]).map((x) => x.name);
    assert.deepEqual(order, ['arxiv', 'doi', 'title-only', 'inconclusive-old', 'inconclusive-new', 'expired']);
  });
});

describe('fetchWithRetry', () => {
  const answer = (status, body = '{}') => async () => ({ status, body });
  it('a 404 is an answer with no data', async () => {
    assert.deepEqual(await fetchWithRetry('u', {}, Infinity, answer(404)), { ok: true, data: null });
  });
  it('a server error or network failure is not an answer', async () => {
    assert.deepEqual(await fetchWithRetry('u', {}, Infinity, answer(500)), { ok: false });
    const fail = async () => { throw new Error('ECONNRESET'); };
    assert.deepEqual(await fetchWithRetry('u', {}, Infinity, fail), { ok: false });
  });
  it('retries a rate limit and returns the answer that follows', async () => {
    let calls = 0;
    const get = async () => (++calls < 2 ? { status: 429, body: '' } : { status: 200, body: '{"x":1}' });
    assert.deepEqual(await fetchWithRetry('u', {}, Infinity, get), { ok: true, data: { x: 1 } });
    assert.equal(calls, 2);
  });
  it('a rate limit whose retry wait would pass the deadline stops instead of waiting', async () => {
    const start = Date.now();
    await assert.rejects(fetchWithRetry('u', {}, Date.now() + 2500, answer(429)), OutOfBudget);
    assert.ok(Date.now() - start < 1000);
  });
  it('refuses to start a request with no time left', async () => {
    await assert.rejects(fetchWithRetry('u', {}, Date.now() + 100, answer(200)), OutOfBudget);
  });
});

describe('runBacklogPass', () => {
  function dir(files) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-abstracts-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, `${name}.md`), text);
    return d;
  }
  const read = (d, name) => parseFrontMatter(fs.readFileSync(path.join(d, `${name}.md`), 'utf-8'));
  const lookups = (byKey) => ({
    external: async (meta) => byKey[meta.zoteroKey]?.external ?? { abstract: null, inconclusive: false },
    pdf: async (meta) => byKey[meta.zoteroKey]?.pdf ?? { abstract: null, inconclusive: false },
  });

  it('writes abstracts and records not_found / inconclusive per item', async () => {
    const d = dir({
      A: item({ zoteroKey: 'A', title: 'Found externally' }),
      B: item({ zoteroKey: 'B', title: 'Found in PDF' }),
      C: item({ zoteroKey: 'C', title: 'Nowhere' }),
      D: item({ zoteroKey: 'D', title: 'Rate limited' }),
    });
    const stats = await runBacklogPass(d, {
      now: () => NOW,
      lookups: lookups({
        A: { external: { abstract: ABSTRACT, source: 'cr_doi' } },
        B: { pdf: { abstract: ABSTRACT } },
        D: { external: { abstract: null, inconclusive: true } },
      }),
    });
    assert.equal(read(d, 'A').meta.abstract_source, 'cr_doi');
    assert.equal(read(d, 'B').meta.abstract_source, 'pdf_extraction');
    assert.equal(read(d, 'C').meta.abstract_lookup, `${NOW.toISOString()} not_found`);
    assert.equal(read(d, 'D').meta.abstract_lookup, `${NOW.toISOString()} inconclusive`);
    assert.deepEqual(
      { tried: stats.tried, enriched: stats.enriched, notFound: stats.notFound, inconclusive: stats.inconclusive },
      { tried: 4, enriched: 2, notFound: 1, inconclusive: 1 },
    );
  });

  it('skips recent not_found items and retries expired ones', async () => {
    const d = dir({
      R: item({ zoteroKey: 'R', abstract_lookup: `${daysAgo(3)} not_found` }),
      X: item({ zoteroKey: 'X', abstract_lookup: `${daysAgo(190)} not_found` }),
    });
    const stats = await runBacklogPass(d, { now: () => NOW, lookups: lookups({}) });
    assert.equal(stats.backlog, 1);
    assert.equal(read(d, 'R').meta.abstract_lookup, `${daysAgo(3)} not_found`);
    assert.equal(read(d, 'X').meta.abstract_lookup, `${NOW.toISOString()} not_found`);
  });

  it('stops starting items once the budget is spent, leaving the rest untouched', async () => {
    const d = dir({ A: item({ zoteroKey: 'A' }), B: item({ zoteroKey: 'B' }) });
    const stats = await runBacklogPass(d, { budgetMs: 1000, now: () => NOW, lookups: lookups({}) });
    assert.equal(stats.tried, 0);
    assert.equal(read(d, 'A').meta.abstract_lookup, undefined);
  });

  it('leaves no record in a dry run', async () => {
    const d = dir({ A: item({ zoteroKey: 'A' }) });
    await runBacklogPass(d, { dryRun: true, now: () => NOW, lookups: lookups({}) });
    assert.equal(read(d, 'A').meta.abstract_lookup, undefined);
  });

  it('forgetNotFound clears not_found records but keeps inconclusive ones', () => {
    const d = dir({
      N: item({ zoteroKey: 'N', abstract_lookup: `${daysAgo(3)} not_found` }),
      I: item({ zoteroKey: 'I', abstract_lookup: `${daysAgo(3)} inconclusive` }),
    });
    assert.equal(forgetNotFound(d), 1);
    assert.equal(read(d, 'N').meta.abstract_lookup, undefined);
    assert.equal(read(d, 'I').meta.abstract_lookup, `${daysAgo(3)} inconclusive`);
  });
});

describe('backoffFromResponse (Zotero)', () => {
  const T = 1_000_000;
  it('no wait on a plain success', () => assert.equal(backoffFromResponse(200, {}, T), 0));
  it('honours Backoff on any response', () => assert.equal(backoffFromResponse(200, { backoff: '30' }, T), T + 30_000));
  it('honours Retry-After on 429 and 503', () => {
    assert.equal(backoffFromResponse(429, { 'retry-after': '5' }, T), T + 5_000);
    assert.equal(backoffFromResponse(503, { 'retry-after': '60' }, T), T + 60_000);
  });
  it('a 429 without Retry-After stops Zotero requests for the rest of the run', () =>
    assert.equal(backoffFromResponse(429, {}, T), Infinity));
  it('a rejected key stops Zotero requests for the rest of the run', () => {
    assert.equal(backoffFromResponse(403, {}, T), Infinity);
    assert.equal(backoffFromResponse(401, {}, T), Infinity);
  });
  it('ignores Retry-After on other statuses', () => assert.equal(backoffFromResponse(200, { 'retry-after': '5' }, T), 0));
});

// ── syncLibrary ───────────────────────────────────────────────────────────────

describe('syncLibrary', () => {
  // A library at version 12 that, since version 10, changed item NEW1 and
  // deleted item GONE.
  function zotero({ deletedFails }) {
    return async (url) => {
      const json = (body) => ({
        ok: true,
        status: 200,
        headers: { get: () => '12' },
        json: async () => body,
      });
      if (url.includes('/deleted')) {
        if (deletedFails) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
        return json({ items: ['GONE'] });
      }
      if (url.includes('start=0')) return json([{ key: 'NEW1', data: { title: 'New paper', itemType: 'journalArticle' } }]);
      return json([]);
    };
  }

  async function run(deletedFails) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-sync-'));
    const output = path.join(dir, 'zotero-md');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, 'GONE.md'), 'deleted in Zotero\n');
    const stateFile = path.join(dir, 'zotero-state.json');
    const realFetch = globalThis.fetch;
    globalThis.fetch = zotero({ deletedFails });
    try {
      const result = await syncLibrary({ since: 10, output, stateFile, apiBase: 'https://z', userId: 'u', apiKey: 'k' })
        .then((r) => ({ ok: true, r }))
        .catch((err) => ({ ok: false, err }));
      return { dir, output, stateFile, result };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('applies changes and deletions, and records the new version', async () => {
    const { output, stateFile, result } = await run(false);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(output, 'NEW1.md')), true);
    assert.equal(fs.existsSync(path.join(output, 'GONE.md')), false);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.equal(state.newVersion, 12);
    assert.equal(state.deletedCount, 1);
  });

  // The deletions used to be fetched best-effort: on a failure the run still
  // recorded version 12, the next run asked only for deletions since 12, and
  // GONE.md stayed for good.
  it('fails the whole run, writing nothing, when the deletions cannot be fetched', async () => {
    const { output, stateFile, result } = await run(true);
    assert.equal(result.ok, false);
    assert.match(result.err.message, /deleted/);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(fs.existsSync(path.join(output, 'GONE.md')), true);
    assert.equal(fs.existsSync(path.join(output, 'NEW1.md')), false);
  });
});
