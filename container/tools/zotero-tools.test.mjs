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
  it('a rate limit whose backoff would pass the deadline stops instead of waiting', async () => {
    const start = Date.now();
    await assert.rejects(fetchWithRetry('u', {}, Date.now() + 3000, answer(429)), OutOfBudget);
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
