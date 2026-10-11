#!/usr/bin/env node
/**
 * Fetch missing abstracts for Zotero markdown files.
 * Reads *.md files in OUTPUT_DIR, skips those already with abstracts,
 * queries Semantic Scholar then CrossRef in order:
 *   1. DOI       → S2
 *   2. DOI       → CrossRef
 *   3. arXiv ID  → S2
 *   4. URL-DOI   → S2 → CrossRef
 *   5. Title     → S2 → CrossRef
 *
 * Usage (inside container, run by agent via Bash):
 *   node /app/tools/zotero-enrich.mjs --dir /workspace/agent/zotero-md
 *   node /app/tools/zotero-enrich.mjs --dir /workspace/agent/zotero-md --dry-run
 *   node /app/tools/zotero-enrich.mjs --dir /workspace/agent/zotero-md --limit 10
 *
 * Output (JSON to stdout):
 *   { enriched, notFound, inconclusive, errors, total, sourceCounts }
 *
 * findAbstract is also imported by zotero-abstracts.mjs, the budgeted backlog
 * run (zotero.allium EnrichmentRun). It tells "every source answered and none
 * had an abstract" (not_found) from "some source could not be asked"
 * (inconclusive), and stops short of a deadline rather than overrunning it.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { parseArgs } from 'util';
import { pathToFileURL } from 'url';
import { parseFrontMatter, applyAbstract, hasAbstract, validateAbstract } from './zotero-frontmatter.mjs';

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { values: args } = parseArgs({
  options: {
    dir:      { type: 'string' },
    'dry-run':{ type: 'boolean', default: false },
    limit:    { type: 'string'  },
    'doi-only':{ type: 'boolean', default: false },
    's2-only': { type: 'boolean', default: false },
    'cr-only': { type: 'boolean', default: false },
  },
  strict: false,
});

const DIR      = args.dir || '/workspace/agent/zotero-md';
const DRY_RUN  = args['dry-run'] || false;
const LIMIT    = args.limit ? parseInt(args.limit, 10) : null;
const CLI_OPTS = {
  doiOnly: args['doi-only'] || false,
  skipS2:  args['cr-only']  || false,
  skipCr:  args['s2-only']  || false,
};

const S2_FIELDS  = 'title,abstract,year,externalIds';
const TITLE_MATCH = 0.80;
const S2_PAUSE_MS = 3500;
const CR_PAUSE_MS = 1000;
const REQUEST_TIMEOUT_MS = 12000;
const MIN_REQUEST_MS = 1000;   // don't start a request with less time than this left
const CR_MAILTO   = process.env.CROSSREF_MAILTO || '';

// ── Budget ────────────────────────────────────────────────────────────────────

/** Thrown when a pause or request would run past the caller's deadline. */
export class OutOfBudget extends Error {}

function remaining(deadline) {
  return deadline - Date.now();
}

async function pause(ms, deadline) {
  if (remaining(deadline) < ms + MIN_REQUEST_MS) throw new OutOfBudget();
  await sleep(ms);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'zotero-enrich/1.0', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * { ok: true, data } when the source answered (data null for 404/400: it has
 * no such record); { ok: false } when it could not be asked — network error,
 * unexpected status, rate-limit retries exhausted. OutOfBudget propagates.
 */
export async function fetchWithRetry(url, headers = {}, deadline = Infinity, get = httpGet) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const left = remaining(deadline);
    if (left < MIN_REQUEST_MS) throw new OutOfBudget();
    let r;
    try {
      r = await get(url, headers, Math.min(REQUEST_TIMEOUT_MS, left));
    } catch {
      return { ok: false };
    }
    if (r.status === 200) {
      try {
        return { ok: true, data: JSON.parse(r.body) };
      } catch {
        return { ok: false };
      }
    }
    if (r.status === 404 || r.status === 400) return { ok: true, data: null };
    if (r.status === 429) {
      if (attempt === 3) break;
      const wait = 5000 * (2 ** attempt);
      process.stderr.write(`  rate limited (${url.slice(0, 60)}), waiting ${wait / 1000}s\n`);
      await pause(wait, deadline);
      continue;
    }
    return { ok: false };
  }
  return { ok: false };
}

// ── Identifier extraction ─────────────────────────────────────────────────────

function extractArxivId(url) {
  if (!url) return null;
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([0-9v.]+)/i);
  return m ? m[1] : null;
}

function extractDoiFromUrl(url) {
  if (!url) return null;
  const m = url.match(/(?:doi\.org\/|\/doi\/)(10\.\d{4,}\/\S+)/i);
  return m ? m[1].replace(/[.,;]+$/, '') : null;
}

function titleSim(a, b) {
  if (!a || !b) return 0;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const na = norm(a).split(' ');
  const nb = norm(b).split(' ');
  const setA = new Set(na);
  const setB = new Set(nb);
  const intersect = [...setA].filter((w) => setB.has(w)).length;
  return (2 * intersect) / (setA.size + setB.size);
}

// ── Semantic Scholar ──────────────────────────────────────────────────────────

function encodeId(id) {
  return encodeURIComponent(id).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
}

// Each lookup returns { ok, abstract }: ok false means the source was not asked.

async function s2ById(identifier, deadline) {
  await pause(S2_PAUSE_MS, deadline);
  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeId(identifier)}?fields=${S2_FIELDS}`;
  const r = await fetchWithRetry(url, {}, deadline);
  return { ok: r.ok, abstract: r.ok ? validateAbstract(r.data?.abstract) : null };
}

async function s2ByTitle(title, deadline) {
  await pause(S2_PAUSE_MS, deadline);
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}&limit=3`;
  const r = await fetchWithRetry(url, {}, deadline);
  if (!r.ok) return { ok: false, abstract: null };
  for (const paper of r.data?.data || []) {
    if (titleSim(title, paper.title) >= TITLE_MATCH) {
      const ab = validateAbstract(paper.abstract);
      if (ab) return { ok: true, abstract: ab };
    }
  }
  return { ok: true, abstract: null };
}

// ── CrossRef ──────────────────────────────────────────────────────────────────

function jatsStrip(text) {
  return text
    .replace(/<\/?jats:[^>]+>/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function crAbstract(msg) {
  if (!msg?.abstract) return null;
  return validateAbstract(jatsStrip(msg.abstract));
}

async function crByDoi(doi, deadline) {
  await pause(CR_PAUSE_MS, deadline);
  let url = `https://api.crossref.org/works/${encodeId(doi)}`;
  if (CR_MAILTO) url += `?mailto=${encodeURIComponent(CR_MAILTO)}`;
  const r = await fetchWithRetry(url, {}, deadline);
  return { ok: r.ok, abstract: r.ok ? crAbstract(r.data?.message) : null };
}

async function crByTitle(title, deadline) {
  await pause(CR_PAUSE_MS, deadline);
  const params = new URLSearchParams({
    'query.bibliographic': title,
    rows: '3',
    select: 'DOI,title,abstract',
  });
  if (CR_MAILTO) params.set('mailto', CR_MAILTO);
  const url = `https://api.crossref.org/works?${params}`;
  const r = await fetchWithRetry(url, {}, deadline);
  if (!r.ok) return { ok: false, abstract: null };
  for (const item of r.data?.message?.items || []) {
    const t = (item.title || [])[0] || '';
    if (titleSim(title, t) >= TITLE_MATCH) {
      const ab = crAbstract(item);
      if (ab) return { ok: true, abstract: ab };
    }
  }
  return { ok: true, abstract: null };
}

// ── Enrichment logic ──────────────────────────────────────────────────────────

/**
 * Try the sources in zotero.allium AbstractEnriched order.
 * Returns { abstract, source } on success, else { abstract: null, inconclusive }
 * where inconclusive is true when any applicable source went unasked —
 * including running out of time before `deadline` (ms since epoch).
 */
export async function findAbstract(meta, title, opts = {}) {
  const { deadline = Infinity, doiOnly = false, skipS2 = false, skipCr = false } = opts;
  const doi = meta.doi || null;
  const url = meta.url || null;
  const arxiv = extractArxivId(url);
  const urlDoi = extractDoiFromUrl(url);
  const titled = !doiOnly && title && title.length > 10;

  const attempts = [
    [doi && !skipS2, 's2_doi', () => s2ById(doi, deadline)],
    [doi && !skipCr, 'cr_doi', () => crByDoi(doi, deadline)],
    [arxiv && !skipS2, 's2_arxiv', () => s2ById(`ARXIV:${arxiv}`, deadline)],
    [urlDoi && urlDoi !== doi && !skipS2, 's2_url_doi', () => s2ById(urlDoi, deadline)],
    [urlDoi && urlDoi !== doi && !skipCr, 'cr_url_doi', () => crByDoi(urlDoi, deadline)],
    [titled && !skipS2, 's2_title', () => s2ByTitle(title, deadline)],
    [titled && !skipCr, 'cr_title', () => crByTitle(title, deadline)],
  ];

  let inconclusive = false;
  for (const [applies, source, lookup] of attempts) {
    if (!applies) continue;
    let r;
    try {
      r = await lookup();
    } catch (err) {
      if (err instanceof OutOfBudget) return { abstract: null, inconclusive: true };
      throw err;
    }
    if (r.abstract) return { abstract: r.abstract, source };
    if (!r.ok) inconclusive = true;
  }
  return { abstract: null, inconclusive };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(DIR, f));

  const toEnrich = files.filter((fp) => {
    const text = fs.readFileSync(fp, 'utf-8');
    const parsed = parseFrontMatter(text);
    return parsed ? !hasAbstract(parsed.body) : false;
  });

  process.stderr.write(`Files missing abstracts: ${toEnrich.length} / ${files.length}\n`);

  const batch = LIMIT ? toEnrich.slice(0, LIMIT) : toEnrich;
  if (LIMIT) process.stderr.write(`Processing first ${batch.length} (--limit)\n`);

  let enriched = 0, notFound = 0, inconclusive = 0, errors = 0;
  const sourceCounts = {};

  for (const fp of batch) {
    const text    = fs.readFileSync(fp, 'utf-8');
    const parsed  = parseFrontMatter(text);
    if (!parsed) { errors++; continue; }
    const { meta, body: _body } = parsed;
    const title = meta.title || path.basename(fp, '.md');

    try {
      const found = await findAbstract(meta, title, CLI_OPTS);
      const { abstract, source } = found;
      if (abstract) {
        if (!DRY_RUN) fs.writeFileSync(fp, applyAbstract(text, abstract, source), 'utf-8');
        process.stderr.write(`  ✓ [${(source || '').padEnd(12)}] ${title.slice(0, 60)}\n`);
        enriched++;
        sourceCounts[source] = (sourceCounts[source] || 0) + 1;
      } else if (found.inconclusive) {
        process.stderr.write(`  ?              ${title.slice(0, 60)}\n`);
        inconclusive++;
      } else {
        // External sources only: record not_found only when the PDF can't help
        // either is zotero-abstracts.mjs's call, so the CLI leaves no record.
        process.stderr.write(`  –              ${title.slice(0, 60)}\n`);
        notFound++;
      }
    } catch (err) {
      process.stderr.write(`  ✗ error: ${err.message} — ${title.slice(0, 50)}\n`);
      errors++;
    }
  }

  process.stderr.write(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.\n`);
  process.stderr.write(`  Enriched: ${enriched}  |  Not found: ${notFound}  |  Inconclusive: ${inconclusive}  |  Errors: ${errors}\n`);
  if (Object.keys(sourceCounts).length) {
    process.stderr.write('  Breakdown:\n');
    for (const [src, n] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
      process.stderr.write(`    ${src.padEnd(14)} ${n}\n`);
    }
  }

  console.log(JSON.stringify({ enriched, notFound, inconclusive, errors, total: batch.length, sourceCounts }));
}

if (isMain) await main();
