/**
 * Abstract obligations from specs/zotero.allium: EnrichmentRun,
 * AbstractEnriched, PdfAbstractExtracted, AbstractLookupRecorded, the
 * AbstractSource / AbstractLookupResult enums, the length and size config,
 * and the abstract invariants.
 *
 * These rules are the host-run scripts in container/tools/ (zotero-abstracts,
 * zotero-enrich, zotero-extract-abstracts), driven here as the host drives
 * them: one runBacklogPass over a real zotero-md directory in a temp folder.
 * Semantic Scholar, CrossRef and the Zotero file API are a fake `https.get`;
 * pdftotext is a fake that returns the downloaded "PDF"'s text, so the suite
 * needs neither network nor poppler.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';

vi.mock('https', async () => (await import('./tools.js')).httpsMock);
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // pdftotext -f 1 -l 4 <pdf> -  →  the fake PDF is its own text
    execFileSync: (cmd: string, args: string[], opts: unknown) =>
      cmd === 'pdftotext'
        ? fs.readFileSync(args[4], 'utf-8')
        : (actual.execFileSync as (...a: unknown[]) => unknown)(cmd, args, opts),
  };
});

import { obligation } from './harness.js';
import {
  fastPauses,
  itemFile,
  json,
  loadTool,
  net,
  words,
  type Abstracts,
  type Enrich,
  type Extract,
  type FakeResponse,
  type Frontmatter,
  type LookupResult,
  type Lookups,
} from './tools.js';

// zotero-extract-abstracts.mjs reads its credentials and API base at load.
vi.stubEnv('ZOTERO_API_KEY', 'zk');
vi.stubEnv('ZOTERO_USER_ID', '42');
vi.stubEnv('ZOTERO_API_BASE', 'https://zotero.test');

const fm = await loadTool<Frontmatter>('zotero-frontmatter.mjs');
const enrich = await loadTool<Enrich>('zotero-enrich.mjs');
const extract = await loadTool<Extract>('zotero-extract-abstracts.mjs');
const abstracts = await loadTool<Abstracts>('zotero-abstracts.mjs');

const NOW = new Date('2026-10-29T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const ZOTERO = 'https://zotero.test/users/42';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-spec-abstracts-'));
  net.reset();
  extract._resetZoteroBackoff();
  fastPauses();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function write(key: string, text: string): void {
  fs.writeFileSync(path.join(dir, `${key}.md`), text);
}

function read(key: string): string {
  return fs.readFileSync(path.join(dir, `${key}.md`), 'utf-8');
}

/** The ItemFile fields the spec names, read back from the file. */
function itemOf(key: string) {
  const parsed = fm.parseFrontMatter(read(key))!;
  const lines = parsed.body.split('\n').filter((l) => l.trim());
  const lookup = fm.parseLookup(parsed.meta);
  return {
    item_key: parsed.meta.zoteroKey,
    title: parsed.meta.title,
    abstract: fm.hasAbstract(parsed.body) ? lines.slice(2).join('\n') : null,
    abstract_source: parsed.meta.abstract_source ?? null,
    abstract_lookup_at: lookup?.at ?? null,
    abstract_lookup_result: lookup?.result ?? null,
    hasLookupLine: 'abstract_lookup' in parsed.meta,
  };
}

const noPdf: Lookups['pdf'] = async () => ({ abstract: null, inconclusive: false, reason: 'no PDF' });
const noExternal: Lookups['external'] = async () => ({ abstract: null, inconclusive: false });

/** One host pass (EnrichmentRun) with the real external lookups and the given PDF step. */
function passWithExternal(pdf: Lookups['pdf'] = noPdf) {
  return abstracts.runBacklogPass(dir, { now: () => NOW, lookups: { external: enrich.findAbstract, pdf } });
}

/** One host pass with the real PDF step and no external result. */
function passWithPdf(external: Lookups['external'] = noExternal) {
  return abstracts.runBacklogPass(dir, { now: () => NOW, lookups: { external, pdf: extract.findPdfAbstract } });
}

const s2 = (u: string) => u.startsWith('https://api.semanticscholar.org/');
const cr = (u: string) => u.startsWith('https://api.crossref.org/');

/** Zotero children + file routes for one item's PDF attachment. */
function pdfRoutes(
  itemKey: string,
  pdf: { size: number; text: string; contentType?: string; linkMode?: string } | null,
): (u: string) => FakeResponse | undefined {
  return (u) => {
    if (u === `${ZOTERO}/items/${itemKey}/children`) {
      if (!pdf) return json([]);
      return json([
        {
          key: 'ATT1',
          data: {
            itemType: 'attachment',
            contentType: pdf.contentType ?? 'application/pdf',
            linkMode: pdf.linkMode ?? 'imported_file',
          },
          links: { enclosure: { length: pdf.size } },
        },
      ]);
    }
    if (u === `${ZOTERO}/items/ATT1/file` && pdf) return { status: 200, body: pdf.text };
    return undefined;
  };
}

const pdfText = (abstract: string) =>
  `A Paper Title\nJane Doe\n\nAbstract\n${abstract}\n\n1 Introduction\nThe body of the paper.\n`;

// ── Enums ───────────────────────────────────────────────────────────────────

obligation('enum-comparable.AbstractSource', async () => {
  // Every source the code can record is one of the spec's eight variants, and
  // recorded values compare by plain string equality.
  const ABSTRACT = words(200);
  const cases: Array<[Record<string, string>, string, (u: string) => boolean]> = [
    [{ doi: '10.1000/a' }, 's2_doi', (u) => s2(u) && u.includes('/paper/10.1000/a?')],
    [{ doi: '10.1000/a' }, 'cr_doi', (u) => cr(u) && u.includes('/works/10.1000/a')],
    [{ url: 'https://arxiv.org/abs/2101.00001' }, 's2_arxiv', (u) => s2(u) && u.includes('ARXIV:2101.00001')],
    [{ url: 'https://doi.org/10.2000/b' }, 's2_url_doi', (u) => s2(u) && u.includes('/paper/10.2000/b?')],
    [{ url: 'https://doi.org/10.2000/b' }, 'cr_url_doi', (u) => cr(u) && u.includes('/works/10.2000/b')],
    [{}, 's2_title', (u) => s2(u) && u.includes('/paper/search/match')],
    [{}, 'cr_title', (u) => cr(u) && u.includes('query.bibliographic')],
  ];
  const TITLE = 'Reasoning about distributed systems with specifications';
  const recorded: string[] = [];
  for (const [meta, expected, answers] of cases) {
    net.reset();
    net.route = (u) => {
      if (!answers(u)) return undefined;
      if (u.includes('/paper/search/match')) return json({ data: [{ title: TITLE, abstract: ABSTRACT }] });
      if (u.includes('query.bibliographic'))
        return json({ message: { items: [{ title: [TITLE], abstract: ABSTRACT }] } });
      return cr(u) ? json({ message: { abstract: ABSTRACT } }) : json({ abstract: ABSTRACT });
    };
    const found = await enrich.findAbstract(meta, TITLE);
    expect(found.source, `meta ${JSON.stringify(meta)}`).toBe(expected);
    recorded.push(found.source!);
  }

  write('PDF1', itemFile('PDF1'));
  net.reset();
  net.route = pdfRoutes('PDF1', { size: 1000, text: pdfText(ABSTRACT) });
  await passWithPdf();
  recorded.push(itemOf('PDF1').abstract_source!);

  const SPEC = ['s2_doi', 's2_arxiv', 's2_url_doi', 's2_title', 'cr_doi', 'cr_url_doi', 'cr_title', 'pdf_extraction'];
  expect([...recorded].sort()).toEqual([...SPEC].sort());
  expect(recorded.filter((s) => s === 's2_doi')).toEqual(['s2_doi']);
});

obligation('enum-comparable.AbstractLookupResult', () => {
  const text = itemFile('K');
  for (const result of ['not_found', 'inconclusive']) {
    const parsed = fm.parseFrontMatter(fm.recordLookup(text, NOW, result))!;
    expect(fm.parseLookup(parsed.meta)).toEqual({ at: NOW.toISOString(), result });
  }
  // A value outside the enum is not a lookup result at all.
  const bogus = fm.parseFrontMatter(fm.recordLookup(text, NOW, 'gave_up'))!;
  expect(fm.parseLookup(bogus.meta)).toBeNull();
  // The two variants are distinct: an inconclusive record keeps the item in
  // the backlog where a fresh not_found takes it out.
  const notFound = fm.parseFrontMatter(fm.recordLookup(text, NOW, 'not_found'));
  const inconclusive = fm.parseFrontMatter(fm.recordLookup(text, NOW, 'inconclusive'));
  expect(fm.inBacklog(notFound, NOW)).toBe(false);
  expect(fm.inBacklog(inconclusive, NOW)).toBe(true);
});

// ── External entities: the PDF attachment ───────────────────────────────────

obligation('entity-optional.ZoteroItem.pdf_attachment', async () => {
  // null: no PDF child — a conclusive miss, nothing downloaded
  net.route = pdfRoutes('NOPDF', null);
  const none = await extract.findPdfAbstract({ zoteroKey: 'NOPDF' });
  expect(none).toMatchObject({ abstract: null, inconclusive: false, reason: 'no PDF' });
  expect(net.requests.some((u) => u.endsWith('/file'))).toBe(false);

  // non-null: the attachment is downloaded and read
  net.reset();
  net.route = pdfRoutes('WITHPDF', { size: 2000, text: pdfText(words(150)) });
  const some = await extract.findPdfAbstract({ zoteroKey: 'WITHPDF' });
  expect(some.abstract).toBe(words(150));
});

obligation('entity-fields.PdfAttachment', async () => {
  // item: the attachment is found among the item's own children;
  // size: read from the attachment's enclosure length (bytes).
  net.route = pdfRoutes('ITEMKEY1', { size: 20_000_000, text: pdfText(words(150)) });
  const r = await extract.findPdfAbstract({ zoteroKey: 'ITEMKEY1' });
  expect(net.requests[0]).toBe(`${ZOTERO}/items/ITEMKEY1/children`);
  expect(r).toMatchObject({ abstract: null, reason: 'too large' });

  // Only a stored PDF file is an attachment: a linked PDF has nothing to download.
  net.reset();
  net.route = pdfRoutes('ITEMKEY2', { size: 2000, text: pdfText(words(150)), linkMode: 'linked_url' });
  expect(await extract.findPdfAbstract({ zoteroKey: 'ITEMKEY2' })).toMatchObject({ abstract: null, reason: 'no PDF' });
});

// ── ItemFile optional fields written by the abstract rules ──────────────────

obligation('entity-optional.ItemFile.abstract_source', async () => {
  write('A', itemFile('A', { doi: '10.1000/a' }));
  expect(itemOf('A').abstract_source).toBeNull();

  net.route = (u) => (s2(u) ? json({ abstract: words(200) }) : undefined);
  await passWithExternal();
  expect(itemOf('A').abstract_source).toBe('s2_doi');
});

obligation('entity-optional.ItemFile.abstract_lookup_at', async () => {
  write('A', itemFile('A'));
  expect(itemOf('A').abstract_lookup_at).toBeNull();
  await abstracts.runBacklogPass(dir, { now: () => NOW, lookups: { external: noExternal, pdf: noPdf } });
  expect(itemOf('A').abstract_lookup_at).toBe(NOW.toISOString());
});

obligation('entity-optional.ItemFile.abstract_lookup_result', async () => {
  write('A', itemFile('A'));
  write('B', itemFile('B'));
  expect(itemOf('A').abstract_lookup_result).toBeNull();
  await abstracts.runBacklogPass(dir, {
    now: () => NOW,
    lookups: {
      external: async (meta) => ({ abstract: null, inconclusive: meta.zoteroKey === 'B' }),
      pdf: noPdf,
    },
  });
  expect(itemOf('A').abstract_lookup_result).toBe('not_found');
  expect(itemOf('B').abstract_lookup_result).toBe('inconclusive');
});

// ── Config ──────────────────────────────────────────────────────────────────

obligation('config-default.max_pdf_size', async () => {
  // 15_000_000 bytes is within the limit; one byte more is not.
  net.route = pdfRoutes('AT', { size: 15_000_000, text: pdfText(words(150)) });
  expect((await extract.findPdfAbstract({ zoteroKey: 'AT' })).abstract).toBe(words(150));

  net.reset();
  net.route = pdfRoutes('OVER', { size: 15_000_001, text: pdfText(words(150)) });
  expect(await extract.findPdfAbstract({ zoteroKey: 'OVER' })).toMatchObject({ abstract: null, reason: 'too large' });
  expect(net.requests.some((u) => u.endsWith('/file'))).toBe(false);
});

obligation('config-default.min_abstract_length', () => {
  expect(fm.MIN_ABSTRACT).toBe(80);
  expect(fm.validateAbstract(words(80))).toBe(words(80));
  expect(fm.validateAbstract(words(79))).toBeNull();
});

obligation('config-default.max_abstract_length', () => {
  expect(fm.MAX_ABSTRACT).toBe(3000);
  // Text of exactly the maximum is accepted as it is.
  expect(fm.validateAbstract(words(3000))).toBe(words(3000));
});

// ── EnrichmentRun ───────────────────────────────────────────────────────────

obligation('rule-success.EnrichmentRun', async () => {
  write('A', itemFile('A')); // never looked up, title only
  write('B', itemFile('B', { doi: '10.1000/b' })); // never looked up, has a DOI
  write('C', itemFile('C', { abstract_lookup: `${daysAgo(5)} inconclusive` }));
  write('G', itemFile('G', { abstract_lookup: `${daysAgo(10)} inconclusive` }));
  write('D', itemFile('D', { abstract_lookup: `${daysAgo(200)} not_found` }));
  write('H', itemFile('H', { abstract_lookup: `${daysAgo(300)} not_found` }));
  write('E', itemFile('E', { abstract_lookup: `${daysAgo(3)} not_found` })); // not in the backlog
  write('F', itemFile('F', {}, words(150))); // has an abstract: not in the backlog
  const untouched = { E: read('E'), F: read('F') };

  const calls: string[] = [];
  const lookups: Lookups = {
    external: async (meta): Promise<LookupResult> => {
      calls.push(`external:${meta.zoteroKey}`);
      if (meta.zoteroKey === 'B') return { abstract: words(120), source: 's2_doi' };
      return { abstract: null, inconclusive: meta.zoteroKey === 'C' };
    },
    pdf: async (meta): Promise<LookupResult> => {
      calls.push(`pdf:${meta.zoteroKey}`);
      return meta.zoteroKey === 'A' ? { abstract: words(130) } : { abstract: null, inconclusive: false };
    },
  };

  // The run is bounded: with less budget than one item needs, nothing starts.
  const starved = await abstracts.runBacklogPass(dir, { budgetMs: 1000, now: () => NOW, lookups });
  expect(starved).toMatchObject({ backlog: 6, tried: 0 });
  expect(calls).toEqual([]);

  const stats = await abstracts.runBacklogPass(dir, { now: () => NOW, lookups });
  // Priority: never looked up (identifier first), then inconclusive, then
  // expired not_found, each oldest lookup first; per item the external
  // sources, then the PDF (only if the sources found nothing).
  expect(calls).toEqual([
    'external:B',
    'external:A',
    'pdf:A',
    'external:G',
    'pdf:G',
    'external:C',
    'pdf:C',
    'external:H',
    'pdf:H',
    'external:D',
    'pdf:D',
  ]);
  expect(stats).toMatchObject({ backlog: 6, tried: 6, enriched: 2, notFound: 3, inconclusive: 1 });
  // Each item's outcome is in its file.
  expect(itemOf('B')).toMatchObject({ abstract: words(120), abstract_source: 's2_doi' });
  expect(itemOf('A')).toMatchObject({ abstract: words(130), abstract_source: 'pdf_extraction' });
  expect(itemOf('C')).toMatchObject({ abstract_lookup_result: 'inconclusive', abstract_lookup_at: NOW.toISOString() });
  for (const k of ['G', 'H', 'D']) expect(itemOf(k).abstract_lookup_result).toBe('not_found');
  expect({ E: read('E'), F: read('F') }).toEqual(untouched);
});

// ── AbstractLookupRecorded ──────────────────────────────────────────────────

obligation('rule-success.AbstractLookupRecorded', async () => {
  // X: every source answered with nothing, no PDF          → not_found
  // Y: Semantic Scholar could not be asked (server error)    → inconclusive
  // Z: sources answered, but the PDF could not be fetched    → inconclusive
  write('X', itemFile('X', { doi: '10.1000/x' }));
  write('Y', itemFile('Y', { doi: '10.1000/y' }));
  write('Z', itemFile('Z', { doi: '10.1000/z' }));
  net.route = (u) => (s2(u) && u.includes('10.1000/y') ? { status: 500 } : undefined);
  await passWithExternal(async (meta) =>
    meta.zoteroKey === 'Z'
      ? { abstract: null, inconclusive: true, reason: 'HTTP 503' }
      : { abstract: null, inconclusive: false, reason: 'no PDF' },
  );
  expect(itemOf('X')).toMatchObject({
    abstract: null,
    abstract_lookup_at: NOW.toISOString(),
    abstract_lookup_result: 'not_found',
  });
  expect(itemOf('Y')).toMatchObject({ abstract_lookup_at: NOW.toISOString(), abstract_lookup_result: 'inconclusive' });
  expect(itemOf('Z')).toMatchObject({ abstract_lookup_at: NOW.toISOString(), abstract_lookup_result: 'inconclusive' });
});

obligation('rule-failure.AbstractLookupRecorded.1', async () => {
  // An item that ends the lookup with an abstract gets no record — and loses
  // the one it had.
  write('A', itemFile('A', { doi: '10.1000/a', abstract_lookup: `${daysAgo(4)} inconclusive` }));
  net.route = (u) => (s2(u) ? json({ abstract: words(150) }) : undefined);
  await passWithExternal();
  expect(itemOf('A')).toMatchObject({
    abstract: words(150),
    abstract_lookup_at: null,
    abstract_lookup_result: null,
    hasLookupLine: false,
  });
});

// ── AbstractEnriched ────────────────────────────────────────────────────────

obligation('rule-success.AbstractEnriched', async () => {
  write('A', itemFile('A', { doi: '10.1000/a' }));
  // DOI → Semantic Scholar has nothing; DOI → CrossRef has it.
  net.route = (u) =>
    cr(u) && u.includes('/works/10.1000/a')
      ? json({ message: { abstract: `<jats:p>${words(200)}</jats:p>` } })
      : undefined;
  await passWithExternal();
  expect(itemOf('A')).toMatchObject({ abstract: words(200), abstract_source: 'cr_doi' });
  expect(net.requests).toHaveLength(2);
  expect(s2(net.requests[0]) && cr(net.requests[1])).toBe(true);
});

obligation('rule-failure.AbstractEnriched.1', async () => {
  // Already has an abstract: not looked up at all.
  write('HAS', itemFile('HAS', { doi: '10.1000/h' }, words(100)));
  const before = read('HAS');
  net.route = (u) => (s2(u) ? json({ abstract: words(200) }) : undefined);
  await passWithExternal();
  expect(net.requests).toEqual([]);
  expect(read('HAS')).toBe(before);

  // Gains one while the lookup runs (a sync rewrote it): the sync's abstract stays.
  write('RACE', itemFile('RACE', { doi: '10.1000/r' }));
  net.route = (u) => {
    if (!s2(u)) return undefined;
    write('RACE', itemFile('RACE', { doi: '10.1000/r' }, words(90)));
    return json({ abstract: words(200) });
  };
  await passWithExternal();
  expect(itemOf('RACE')).toMatchObject({ abstract: words(90), abstract_source: null });
});

obligation('rule-failure.AbstractEnriched.2', async () => {
  // Every source answers, none has an abstract: found = null.
  write('A', itemFile('A', { doi: '10.1000/a', url: 'https://arxiv.org/abs/2101.00001' }));
  await passWithExternal();
  // DOI → S2, DOI → CrossRef, arXiv → S2 (the title is too short to search on)
  expect(net.requests).toHaveLength(3);
  expect(itemOf('A')).toMatchObject({ abstract: null, abstract_source: null });
});

obligation('rule-failure.AbstractEnriched.3', async () => {
  write('A', itemFile('A', { doi: '10.1000/a' }));
  net.route = (u) =>
    s2(u) ? json({ abstract: words(79) }) : cr(u) ? json({ message: { abstract: words(40) } }) : undefined;
  await passWithExternal();
  expect(itemOf('A')).toMatchObject({ abstract: null, abstract_source: null });
});

obligation('rule-failure.AbstractEnriched.4', async () => {
  write('A', itemFile('A', { doi: '10.1000/a' }));
  net.route = (u) => (s2(u) ? json({ abstract: words(3500) }) : undefined);
  await passWithExternal();
  expect(itemOf('A').abstract, 'an abstract over 3000 chars must be rejected').toBeNull();
});

// ── PdfAbstractExtracted ────────────────────────────────────────────────────

obligation('rule-success.PdfAbstractExtracted', async () => {
  write('P', itemFile('P'));
  // Line-broken words are joined before the length check.
  const body = `${words(100)} extrac-\ntion of ${words(60)}`;
  net.route = pdfRoutes('P', { size: 1_000_000, text: pdfText(body) });
  await passWithPdf();
  const item = itemOf('P');
  expect(item.abstract_source).toBe('pdf_extraction');
  expect(item.abstract).toBe(`${words(100)} extraction of ${words(60)}`);
  expect(net.requests).toEqual([`${ZOTERO}/items/P/children`, `${ZOTERO}/items/ATT1/file`]);
});

obligation('rule-failure.PdfAbstractExtracted.1', async () => {
  write('P', itemFile('P', {}, words(100)));
  const before = read('P');
  net.route = pdfRoutes('P', { size: 1000, text: pdfText(words(200)) });
  await passWithPdf();
  expect(net.requests).toEqual([]);
  expect(read('P')).toBe(before);
});

obligation('rule-failure.PdfAbstractExtracted.2', async () => {
  write('P', itemFile('P'));
  net.route = pdfRoutes('P', null);
  await passWithPdf();
  expect(net.requests).toEqual([`${ZOTERO}/items/P/children`]);
  expect(itemOf('P')).toMatchObject({ abstract: null, abstract_source: null, abstract_lookup_result: 'not_found' });
});

obligation('rule-failure.PdfAbstractExtracted.3', async () => {
  write('P', itemFile('P'));
  net.route = pdfRoutes('P', { size: 15_000_001, text: pdfText(words(200)) });
  await passWithPdf();
  expect(net.requests.some((u) => u.endsWith('/file'))).toBe(false);
  expect(itemOf('P')).toMatchObject({ abstract: null, abstract_source: null, abstract_lookup_result: 'not_found' });
});

obligation('rule-failure.PdfAbstractExtracted.4', async () => {
  write('P', itemFile('P'));
  net.route = pdfRoutes('P', { size: 1000, text: `A Paper\n\n1 Introduction\n${words(400)}\n` });
  await passWithPdf();
  expect(itemOf('P')).toMatchObject({ abstract: null, abstract_source: null, abstract_lookup_result: 'not_found' });
});

obligation('rule-failure.PdfAbstractExtracted.5', async () => {
  write('P', itemFile('P'));
  net.route = pdfRoutes('P', { size: 1000, text: pdfText(words(79)) });
  await passWithPdf();
  expect(itemOf('P')).toMatchObject({ abstract: null, abstract_source: null });

  // ...and the minimum itself is enough.
  write('Q', itemFile('Q'));
  net.reset();
  net.route = pdfRoutes('Q', { size: 1000, text: pdfText(words(80)) });
  await passWithPdf();
  expect(itemOf('Q')).toMatchObject({ abstract: words(80), abstract_source: 'pdf_extraction' });
});

obligation('rule-failure.PdfAbstractExtracted.6', async () => {
  write('P', itemFile('P'));
  net.route = pdfRoutes('P', { size: 1000, text: pdfText(words(3500)) });
  await passWithPdf();
  // Rejected text counts as extraction finding nothing (AbstractLookupRecorded).
  expect(itemOf('P')).toMatchObject({ abstract: null, abstract_source: null, abstract_lookup_result: 'not_found' });
});

// ── Invariants ──────────────────────────────────────────────────────────────

obligation('invariant.AbstractSourceImpliesAbstract', async () => {
  const check = () => {
    for (const f of fs.readdirSync(dir)) {
      const item = itemOf(f.slice(0, -3));
      if (item.abstract_source !== null) expect(item.abstract, `${f} has a source but no abstract`).not.toBeNull();
    }
  };
  write('A', itemFile('A', { doi: '10.1000/a' }));
  write('B', itemFile('B'));
  write('C', itemFile('C', {}, words(100)));
  check();

  // enrichment from an external source, a PDF, and a miss
  net.route = (u) =>
    s2(u) && u.includes('10.1000/a')
      ? json({ abstract: words(150) })
      : pdfRoutes('B', { size: 10, text: pdfText(words(140)) })(u);
  await abstracts.runBacklogPass(dir, {
    now: () => NOW,
    lookups: { external: enrich.findAbstract, pdf: extract.findPdfAbstract },
  });
  expect(itemOf('A').abstract_source).toBe('s2_doi');
  expect(itemOf('B').abstract_source).toBe('pdf_extraction');
  check();

  // a later miss on another item, a not_found record, and a forgotten record
  write('D', itemFile('D'));
  await abstracts.runBacklogPass(dir, { now: () => NOW, lookups: { external: noExternal, pdf: noPdf } });
  check();
  abstracts.forgetNotFound(dir);
  check();
});

obligation('invariant.AbstractLookupRecordComplete', async () => {
  // The record is one frontmatter line holding both fields, so every write
  // sets or clears them together; a half-written line reads as no record.
  const both = (key: string) => {
    const { abstract_lookup_at: at, abstract_lookup_result: result } = itemOf(key);
    expect(at === null, `${key}: lookup_at ${at}, result ${result}`).toBe(result === null);
  };
  write('A', itemFile('A', { doi: '10.1000/a' }));
  write('B', itemFile('B'));
  write('C', itemFile('C'));
  write('HALF1', itemFile('HALF1', { abstract_lookup: daysAgo(1) }));
  write('HALF2', itemFile('HALF2', { abstract_lookup: 'not-a-date not_found' }));
  for (const k of ['A', 'B', 'C', 'HALF1', 'HALF2']) both(k);
  expect(itemOf('HALF1').abstract_lookup_result).toBeNull();
  expect(itemOf('HALF2').abstract_lookup_at).toBeNull();

  await abstracts.runBacklogPass(dir, {
    now: () => NOW,
    lookups: {
      external: async (meta) => ({ abstract: null, inconclusive: meta.zoteroKey === 'C' }),
      pdf: noPdf,
    },
  });
  for (const k of ['A', 'B', 'C', 'HALF1', 'HALF2']) {
    both(k);
    expect(itemOf(k).abstract_lookup_at).toBe(NOW.toISOString());
  }

  // an abstract clears the record; forgetting a not_found clears it
  write('A', fm.applyAbstract(read('A'), words(150), 's2_doi'));
  abstracts.forgetNotFound(dir);
  for (const k of ['A', 'B', 'C', 'HALF1', 'HALF2']) both(k);
  expect(itemOf('A').abstract_lookup_at).toBeNull();
  expect(itemOf('B').abstract_lookup_at).toBeNull();
  expect(itemOf('C').abstract_lookup_result).toBe('inconclusive');
});
