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
 *   node /workspace/tools/zotero-enrich.mjs --dir /workspace/group/zotero-md
 *   node /workspace/tools/zotero-enrich.mjs --dir /workspace/group/zotero-md --dry-run
 *   node /workspace/tools/zotero-enrich.mjs --dir /workspace/group/zotero-md --limit 10
 *
 * Can also be run directly on the host for testing:
 *   node container/tools/zotero-enrich.mjs --dir groups/main/zotero-md --dry-run --limit 5
 *
 * Output (JSON to stdout):
 *   { enriched, notFound, errors, total, sourceCounts }
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { parseArgs } from 'util';

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

const DIR      = args.dir || '/workspace/group/zotero-md';
const DRY_RUN  = args['dry-run'] || false;
const LIMIT    = args.limit ? parseInt(args.limit, 10) : null;
const DOI_ONLY = args['doi-only'] || false;
const SKIP_S2  = args['cr-only']  || false;
const SKIP_CR  = args['s2-only']  || false;

const S2_FIELDS  = 'title,abstract,year,externalIds';
const TITLE_MATCH = 0.80;
const S2_PAUSE_MS = 3500;
const CR_PAUSE_MS = 1000;
const CR_MAILTO   = process.env.CROSSREF_MAILTO || '';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'zotero-enrich/1.0', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('timeout')); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, headers = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await httpGet(url, headers);
      if (r.status === 200) return JSON.parse(r.body);
      if (r.status === 404 || r.status === 400) return null;
      if (r.status === 429) {
        const wait = 5000 * (2 ** attempt);
        process.stderr.write(`  rate limited (${url.slice(0, 60)}), waiting ${wait / 1000}s\n`);
        await sleep(wait);
        continue;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

// ── Front matter parser ───────────────────────────────────────────────────────

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const end = text.indexOf('\n---', nl + 1);
  if (end < 0) return null;
  const fmText = text.slice(nl + 1, end);
  const bodyStart = end + 4 + (text[end + 4] === '\n' ? 1 : 0);
  const meta = {};
  for (const line of fmText.split('\n')) {
    const colon = line.indexOf(': ');
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 2).trim();
  }
  return { meta, body: text.slice(bodyStart) };
}

function hasAbstract(body) {
  const lines = body.split('\n').filter((l) => l.trim());
  return lines.length > 2;
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

// Encode an identifier for S2/CrossRef URL paths: encode most chars but preserve / and :
function encodeId(id) {
  return encodeURIComponent(id).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
}

async function s2ById(identifier) {
  await sleep(S2_PAUSE_MS);
  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeId(identifier)}?fields=${S2_FIELDS}`;
  const data = await fetchWithRetry(url);
  return data?.abstract || null;
}

async function s2ByTitle(title) {
  await sleep(S2_PAUSE_MS);
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}&limit=3`;
  const data = await fetchWithRetry(url);
  if (!data?.data) return null;
  for (const paper of data.data) {
    if (titleSim(title, paper.title) >= TITLE_MATCH && paper.abstract) {
      return paper.abstract;
    }
  }
  return null;
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
  const clean = jatsStrip(msg.abstract);
  return clean.length >= 80 ? clean : null;
}

async function crByDoi(doi) {
  await sleep(CR_PAUSE_MS);
  let url = `https://api.crossref.org/works/${encodeId(doi)}`;
  if (CR_MAILTO) url += `?mailto=${encodeURIComponent(CR_MAILTO)}`;
  const data = await fetchWithRetry(url);
  return crAbstract(data?.message);
}

async function crByTitle(title) {
  await sleep(CR_PAUSE_MS);
  const params = new URLSearchParams({
    'query.bibliographic': title,
    rows: '3',
    select: 'DOI,title,abstract',
  });
  if (CR_MAILTO) params.set('mailto', CR_MAILTO);
  const url = `https://api.crossref.org/works?${params}`;
  const data = await fetchWithRetry(url);
  if (!data?.message?.items) return null;
  for (const item of data.message.items) {
    const t = (item.title || [])[0] || '';
    if (titleSim(title, t) >= TITLE_MATCH) {
      const ab = crAbstract(item);
      if (ab) return ab;
    }
  }
  return null;
}

// ── Enrichment logic ──────────────────────────────────────────────────────────

async function findAbstract(meta, title) {
  const doi   = meta.doi  || null;
  const url   = meta.url  || null;

  // 1. DOI → S2
  if (doi && !SKIP_S2) {
    const ab = await s2ById(doi);
    if (ab) return [ab, 'S2/DOI'];
  }

  // 2. DOI → CrossRef
  if (doi && !SKIP_CR) {
    const ab = await crByDoi(doi);
    if (ab) return [ab, 'CR/DOI'];
  }

  // 3. arXiv → S2
  const arxiv = extractArxivId(url);
  if (arxiv && !SKIP_S2) {
    const ab = await s2ById(`ARXIV:${arxiv}`);
    if (ab) return [ab, 'S2/arXiv'];
  }

  // 4+5. URL-embedded DOI → S2, CrossRef
  const urlDoi = extractDoiFromUrl(url);
  if (urlDoi && urlDoi !== doi) {
    if (!SKIP_S2) {
      const ab = await s2ById(urlDoi);
      if (ab) return [ab, 'S2/URL-DOI'];
    }
    if (!SKIP_CR) {
      const ab = await crByDoi(urlDoi);
      if (ab) return [ab, 'CR/URL-DOI'];
    }
  }

  if (DOI_ONLY) return [null, null];

  // 6. Title → S2
  if (title && title.length > 10 && !SKIP_S2) {
    const ab = await s2ByTitle(title);
    if (ab) return [ab, 'S2/title'];
  }

  // 7. Title → CrossRef
  if (title && title.length > 10 && !SKIP_CR) {
    const ab = await crByTitle(title);
    if (ab) return [ab, 'CR/title'];
  }

  return [null, null];
}

function insertAbstract(text, abstract) {
  return text.trimEnd() + '\n\n' + abstract.trim() + '\n';
}

// ── Main ──────────────────────────────────────────────────────────────────────

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

let enriched = 0, notFound = 0, errors = 0;
const sourceCounts = {};

for (const fp of batch) {
  const text    = fs.readFileSync(fp, 'utf-8');
  const parsed  = parseFrontMatter(text);
  if (!parsed) { errors++; continue; }
  const { meta, body: _body } = parsed;
  const title = meta.title || path.basename(fp, '.md');

  try {
    const [abstract, source] = await findAbstract(meta, title);
    if (abstract) {
      if (!DRY_RUN) {
        fs.writeFileSync(fp, insertAbstract(text, abstract), 'utf-8');
      }
      process.stderr.write(`  ✓ [${(source || '').padEnd(12)}] ${title.slice(0, 60)}\n`);
      enriched++;
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    } else {
      process.stderr.write(`  –              ${title.slice(0, 60)}\n`);
      notFound++;
    }
  } catch (err) {
    process.stderr.write(`  ✗ error: ${err.message} — ${title.slice(0, 50)}\n`);
    errors++;
  }
}

process.stderr.write(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.\n`);
process.stderr.write(`  Enriched: ${enriched}  |  Not found: ${notFound}  |  Errors: ${errors}\n`);
if (Object.keys(sourceCounts).length) {
  process.stderr.write('  Breakdown:\n');
  for (const [src, n] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    process.stderr.write(`    ${src.padEnd(14)} ${n}\n`);
  }
}

console.log(JSON.stringify({ enriched, notFound, errors, total: batch.length, sourceCounts }));
