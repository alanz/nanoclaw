#!/usr/bin/env node
/**
 * Zotero PDF abstract extractor.
 * For each markdown file in DIR missing an abstract:
 *   1. Fetch child attachments from Zotero API
 *   2. Download the PDF (to a temp file, deleted after processing)
 *   3. Extract the abstract section from the first few pages via pdftotext
 *   4. Insert it into the markdown file
 *
 * Requires: pdftotext (poppler-utils, installed in container)
 *
 * Usage (inside container):
 *   node /app/tools/zotero-extract-abstracts.mjs --dir /workspace/agent/zotero-md
 *   node /app/tools/zotero-extract-abstracts.mjs --dir /workspace/agent/zotero-md --dry-run
 *   node /app/tools/zotero-extract-abstracts.mjs --dir /workspace/agent/zotero-md --limit 10
 *   node /app/tools/zotero-extract-abstracts.mjs --dir /workspace/agent/zotero-md --max-mb 20
 *
 * Output (JSON to stdout):
 *   { found, noPdf, tooLarge, skipped, errors, total }
 *
 * findPdfAbstract is also imported by zotero-abstracts.mjs, the budgeted
 * backlog run (zotero.allium EnrichmentRun).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import http from 'http';
import { execFileSync } from 'child_process';
import { parseArgs } from 'util';
import { pathToFileURL } from 'url';
import { parseFrontMatter, applyAbstract, hasAbstract } from './zotero-frontmatter.mjs';

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const DEFAULT_MAX_PDF_MB = 15;

const { values: args } = parseArgs({
  options: {
    dir:      { type: 'string' },
    'dry-run':{ type: 'boolean', default: false },
    limit:    { type: 'string' },
    'max-mb': { type: 'string', default: String(DEFAULT_MAX_PDF_MB) },
  },
  strict: false,
});

const DIR     = args.dir || '/workspace/agent/zotero-md';
const DRY_RUN = args['dry-run'] || false;
const LIMIT   = args.limit ? parseInt(args.limit, 10) : null;
const MAX_MB  = parseFloat(args['max-mb']);

const API_KEY  = process.env.ZOTERO_API_KEY || '';
const USER_ID  = process.env.ZOTERO_USER_ID || '';
const API_BASE = process.env.ZOTERO_API_BASE || 'https://api.zotero.org';
const BASE_URL = `${API_BASE}/users/${USER_ID}`;
const PAUSE_MS = 1000;
const API_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MIN_DOWNLOAD_MS = 3000;   // don't start a download with less time than this left

// ── Zotero rate limiting ──────────────────────────────────────────────────────
//
// Zotero sends `Backoff: <s>` (any response) when overloaded and 429/503 with an
// optional `Retry-After: <s>`. Repeated violations bring stricter throttling or
// a temporary block, so within one process: honour both, and after a 429/503
// without Retry-After, or a 401/403 (bad key), make no further Zotero requests.

let zoteroBackoffUntil = 0;

/** When Zotero may next be asked, given one response (ms since epoch; 0 = no wait). */
export function backoffFromResponse(status, headers, now = Date.now()) {
  const secs = (name) => {
    const v = parseInt(headers?.[name] ?? '', 10);
    return Number.isFinite(v) && v >= 0 ? v : null;
  };
  const retryAfter = secs('retry-after');
  const backoff = secs('backoff');
  let until = backoff !== null ? now + backoff * 1000 : 0;
  if (status === 429 || status === 503) until = Math.max(until, retryAfter !== null ? now + retryAfter * 1000 : Infinity);
  // A rejected key: each further request counts as another authentication
  // failure, and enough of those block the client.
  if (status === 401 || status === 403) until = Infinity;
  return until;
}

function noteResponse(res) {
  zoteroBackoffUntil = Math.max(zoteroBackoffUntil, backoffFromResponse(res.statusCode, res.headers));
}

/** Wait out a Zotero backoff if it ends in time; false when it does not. */
async function zoteroReady(deadline, needMs) {
  const wait = zoteroBackoffUntil - Date.now();
  if (wait <= 0) return true;
  if (wait + needMs > deadline - Date.now()) return false;
  await sleep(wait);
  return true;
}

/** @internal for tests */
export function _resetZoteroBackoff() {
  zoteroBackoffUntil = 0;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGetJson(url, timeoutMs = API_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'Zotero-API-Key': API_KEY,
        'Zotero-API-Version': '3',
        'User-Agent': 'zotero-extract-abstracts/1.0',
      },
    }, (res) => {
      noteResponse(res);
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(body));
        else reject(Object.assign(new Error(`HTTP ${res.statusCode} for ${url}`), { status: res.statusCode }));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

function httpDownloadToFile(url, destPath, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const req = mod.get(url, {
      headers: {
        'Zotero-API-Key': API_KEY,
        'Zotero-API-Version': '3',
        'User-Agent': 'zotero-extract-abstracts/1.0',
      },
    }, (res) => {
      noteResponse(res);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        // Follow redirect without Zotero auth headers
        const redir = res.headers.location;
        const modR = redir.startsWith('https') ? https : http;
        const req2 = modR.get(redir, { headers: { 'User-Agent': 'zotero-extract-abstracts/1.0' } }, (res2) => {
          // The file server's answer, checked as the first one is: an error
          // page saved as the PDF read as "no abstract" (conclusive) before.
          if (res2.statusCode !== 200) {
            res2.resume();
            reject(Object.assign(new Error(`HTTP ${res2.statusCode} from file server`), { status: res2.statusCode }));
            return;
          }
          const file2 = fs.createWriteStream(destPath);
          res2.pipe(file2);
          file2.on('finish', () => file2.close(resolve));
          file2.on('error', reject);
        });
        req2.on('error', reject);
        req2.setTimeout(timeoutMs, () => { req2.destroy(new Error('timeout')); });
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Zotero API ────────────────────────────────────────────────────────────────

async function getPdfAttachment(itemKey, timeoutMs) {
  const children = await httpGetJson(`${BASE_URL}/items/${itemKey}/children`, timeoutMs);
  for (const child of children) {
    const d = child.data || {};
    if (
      d.itemType === 'attachment' &&
      (d.contentType || '').toLowerCase().includes('pdf') &&
      (d.linkMode === 'imported_file' || d.linkMode === 'imported_url')
    ) {
      const enc = (child.links || {}).enclosure || {};
      return { key: child.key, size: enc.length || 0 };
    }
  }
  return null;
}

// ── Abstract extraction ───────────────────────────────────────────────────────

// Section headings that end an abstract, matched only where a heading can be:
// opening a line (after an optional section number: "1", "1.", "I."), and
// capitalised as headings are ("Introduction", "INTRODUCTION"). Matched
// case-insensitively anywhere, they ended abstracts mid-sentence: "we survey
// the contents of program caches" stopped at "the".
const END_HEADINGS = [
  'Introduction', 'Keywords', 'Keyword', 'Key words', 'Key word', 'Categories', 'Index Terms',
  'CCS Concepts', 'ACM Reference', 'General Terms', 'Subject Areas', 'Contents',
];
const END_MARKERS = new RegExp(
  `(?:^|\\n)[ \\t]*(?:(?:\\d+|[IVX]+)\\.?[ \\t]+)?(?:${END_HEADINGS.flatMap((h) => [h, h.toUpperCase()]).join('|')})\\b`,
);

// The abstract's heading: "Abstract" or "ABSTRACT" opening a line ("Abstract.",
// "Abstract—", "Abstract We …" and "ABSTRACT\n" all occur), never running on
// into a lowercase word. Case-sensitive and line-anchored: the word itself
// ("abstract syntax tree", "Abstract data types are …") is common in the body,
// and matching it there stored body text as the abstract.
const START_MARKER = /(?:^|\n)[ \t]*(?:Abstract|ABSTRACT)\b(?![ \t]+[a-z])[.:\s—–-]*/;

export function extractAbstractFromText(text) {
  text = text.replace(/(\w)-\n(\w)/g, '$1$2');
  text = text.replace(/[ \t]+/g, ' ');

  const m = START_MARKER.exec(text);
  if (!m) return null;

  const after = text.slice(m.index + m[0].length);
  const end = END_MARKERS.exec(after);
  // With no heading to end it, the whole remainder is the candidate, and the
  // length bound below rejects it unless the text really stops there (an
  // abstract-only page). A fixed-length prefix stored body text cut short.
  const raw = end ? after.slice(0, end.index) : after;

  // Leading punctuation is left over from the heading ("Abstract. We …").
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.:;,—–-]+\s*/, '');
  if (cleaned.length < 80) return null;
  // Longer than any real abstract: the end marker was missed or the wrong
  // "Abstract" matched, so this is body text. Reject rather than truncate.
  if (cleaned.length > 3000) return null;

  return cleaned;
}

/**
 * The abstract in a downloaded PDF, or null if it has none. Throws when
 * pdftotext cannot read it (not on PATH, crashed, timed out): the PDF went
 * unread, which is inconclusive (zotero.allium AbstractLookupRecorded), not a
 * miss that hides the item for the retry interval.
 */
function extractAbstractFromPdf(pdfPath) {
  const text = execFileSync('pdftotext', ['-f', '1', '-l', '4', pdfPath, '-'], {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return extractAbstractFromText(text);
}

/**
 * zotero.allium PdfAbstractExtracted for one item. Returns { abstract } on
 * success, else { abstract: null, inconclusive, reason }. No PDF, a PDF over
 * the size limit, or a PDF without an abstract section is conclusive; an API
 * or download failure, pdftotext failing, missing credentials, a Zotero
 * backoff, or too little time left before `deadline` (ms since epoch) is not.
 */
export async function findPdfAbstract(meta, opts = {}) {
  const { deadline = Infinity, maxMb = DEFAULT_MAX_PDF_MB, tmpFile = path.join(os.tmpdir(), `zotero-pdf-${process.pid}.pdf`) } = opts;
  const miss = (inconclusive, reason) => ({ abstract: null, inconclusive, reason });
  if (!API_KEY || !USER_ID) return miss(true, 'no credentials');
  if (!meta.zoteroKey) return miss(false, 'no key');
  const left = () => deadline - Date.now();

  // One Zotero request, retried once after a Retry-After that fits the budget.
  const zotero = async (request) => {
    for (let attempt = 0; ; attempt++) {
      if (!(await zoteroReady(deadline, PAUSE_MS + MIN_DOWNLOAD_MS))) throw new Error('zotero backoff');
      if (left() < PAUSE_MS + MIN_DOWNLOAD_MS) throw new Error('out of time');
      await sleep(PAUSE_MS);
      try {
        return await request();
      } catch (err) {
        if (attempt === 0 && (err.status === 429 || err.status === 503)) continue;
        throw err;
      }
    }
  };

  try {
    const att = await zotero(() => getPdfAttachment(meta.zoteroKey, Math.min(API_TIMEOUT_MS, left())));
    if (!att) return miss(false, 'no PDF');
    if (att.size > 0 && att.size / 1_000_000 > maxMb) return miss(false, 'too large');

    await zotero(() =>
      httpDownloadToFile(`${BASE_URL}/items/${att.key}/file`, tmpFile, Math.min(DOWNLOAD_TIMEOUT_MS, left())),
    );
    const abstract = extractAbstractFromPdf(tmpFile);
    return abstract ? { abstract } : miss(false, 'no abstract in PDF');
  } catch (err) {
    return miss(true, err.message);
  } finally {
    if (fs.existsSync(tmpFile)) try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY || !USER_ID) {
    process.stderr.write('ERROR: ZOTERO_API_KEY and ZOTERO_USER_ID must be set\n');
    process.exit(1);
  }

  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => path.join(DIR, f));

  const toProcess = files.filter((fp) => {
    const text = fs.readFileSync(fp, 'utf-8');
    const parsed = parseFrontMatter(text);
    return parsed ? !hasAbstract(parsed.body) : false;
  });

  process.stderr.write(`Files missing abstracts: ${toProcess.length} / ${files.length}\n`);

  const batch = LIMIT ? toProcess.slice(0, LIMIT) : toProcess;
  if (LIMIT) process.stderr.write(`Processing first ${batch.length} (--limit)\n`);
  process.stderr.write(`Skipping PDFs over ${MAX_MB} MB\n\n`);

  let found = 0, noPdf = 0, tooLarge = 0, skipped = 0, errors = 0;
  const tmpFile = path.join(os.tmpdir(), `zotero-pdf-${process.pid}.pdf`);

  for (const fp of batch) {
    const text   = fs.readFileSync(fp, 'utf-8');
    const parsed = parseFrontMatter(text);
    if (!parsed) { skipped++; continue; }
    const { meta } = parsed;
    const itemKey = meta.zoteroKey;
    const title   = (meta.title || path.basename(fp, '.md')).slice(0, 55);

    if (!itemKey) {
      process.stderr.write(`  ? no key    ${title}\n`);
      skipped++;
      continue;
    }

    try {
      await sleep(PAUSE_MS);
      const att = await getPdfAttachment(itemKey, API_TIMEOUT_MS);

      if (!att) {
        process.stderr.write(`  – no PDF    ${title}\n`);
        noPdf++;
        continue;
      }

      const sizeMb = att.size / 1_000_000;
      if (att.size > 0 && sizeMb > MAX_MB) {
        process.stderr.write(`  – ${sizeMb.toFixed(0)}MB skip  ${title}\n`);
        tooLarge++;
        continue;
      }

      const sizeStr = att.size > 0 ? `${sizeMb.toFixed(1)}MB` : '?MB';
      process.stderr.write(`  ↓ ${sizeStr.padEnd(7)}  ${title}`);

      await sleep(PAUSE_MS);
      await httpDownloadToFile(`${BASE_URL}/items/${att.key}/file`, tmpFile);

      const abstract = extractAbstractFromPdf(tmpFile);
      fs.unlinkSync(tmpFile);

      if (abstract) {
        if (!DRY_RUN) fs.writeFileSync(fp, applyAbstract(text, abstract, 'pdf_extraction'), 'utf-8');
        process.stderr.write(`  ✓\n`);
        found++;
      } else {
        process.stderr.write(`  – (no abstract found in PDF)\n`);
        skipped++;
      }
    } catch (err) {
      if (fs.existsSync(tmpFile)) try { fs.unlinkSync(tmpFile); } catch {}
      process.stderr.write(`  ✗ ${err.message} — ${title}\n`);
      errors++;
    }
  }

  if (fs.existsSync(tmpFile)) try { fs.unlinkSync(tmpFile); } catch {}

  process.stderr.write(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Done.\n`);
  process.stderr.write(`  Found: ${found}  |  No PDF: ${noPdf}  |  Too large: ${tooLarge}  |  Not parsed: ${skipped}  |  Errors: ${errors}\n`);

  console.log(JSON.stringify({ found, noPdf, tooLarge, skipped, errors, total: batch.length }));
}

if (isMain) await main();
