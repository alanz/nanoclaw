#!/usr/bin/env node
/**
 * One budgeted pass over the abstract backlog (zotero.allium EnrichmentRun).
 *
 * The backlog is every item file without an abstract, except those whose last
 * lookup was not_found within the retry interval. Items are taken in priority
 * order (prioritiseBacklog); each gets the external sources, then its PDF, and
 * if neither yields an abstract, an `abstract_lookup: <date> <result>` record.
 * Every item is written as soon as it is done, so a run cut short keeps its
 * work. The pass stops starting items once the budget is spent, and lookups
 * stop short of it rather than overrunning.
 *
 * The host runs this as a pre-task script, inside a fixed script timeout, so
 * the budget must stay below that timeout.
 *
 * Usage (inside container):
 *   node /app/tools/zotero-abstracts.mjs --dir /workspace/agent/zotero-md --budget-seconds 25
 *   node /app/tools/zotero-abstracts.mjs --dir /workspace/agent/zotero-md --dry-run
 *   node /app/tools/zotero-abstracts.mjs --dir /workspace/agent/zotero-md --retry-not-found
 *
 * --retry-not-found forgets every not_found record first (zotero.allium
 * EnrichmentTriggeredOnRequest), so later passes look those items up again.
 *
 * Output (JSON to stdout):
 *   { backlog, tried, enriched, notFound, inconclusive, errors, sourceCounts }
 */

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { pathToFileURL } from 'url';
import {
  applyAbstract,
  hasAbstract,
  inBacklog,
  LOOKUP_FIELD,
  parseFrontMatter,
  parseLookup,
  prioritiseBacklog,
  recordLookup,
  removeFrontMatterField,
} from './zotero-frontmatter.mjs';
import { findAbstract } from './zotero-enrich.mjs';
import { findPdfAbstract } from './zotero-extract-abstracts.mjs';

const DEFAULT_BUDGET_SECONDS = 25;
// Don't start an item with less time than this left: one S2 pause plus a request.
const MIN_ITEM_MS = 5000;

/** Drop not_found records from items without an abstract. Returns how many. */
export function forgetNotFound(dir) {
  let forgotten = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const fp = path.join(dir, f);
    const text = fs.readFileSync(fp, 'utf-8');
    const parsed = parseFrontMatter(text);
    if (!parsed || hasAbstract(parsed.body) || parseLookup(parsed.meta)?.result !== 'not_found') continue;
    fs.writeFileSync(fp, removeFrontMatterField(text, LOOKUP_FIELD), 'utf-8');
    forgotten++;
  }
  return forgotten;
}

/** Read the directory and return the backlog in run order. */
export function loadBacklog(dir, now = new Date()) {
  const entries = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const fp = path.join(dir, f);
    const text = fs.readFileSync(fp, 'utf-8');
    const parsed = parseFrontMatter(text);
    if (inBacklog(parsed, now)) entries.push({ fp, meta: parsed.meta });
  }
  return prioritiseBacklog(entries);
}

/**
 * Run one pass. `lookups` is injectable for tests:
 * { external(meta, title, { deadline }), pdf(meta, { deadline }) }.
 */
export async function runBacklogPass(dir, opts = {}) {
  const {
    budgetMs = DEFAULT_BUDGET_SECONDS * 1000,
    dryRun = false,
    now = () => new Date(),
    lookups = { external: findAbstract, pdf: findPdfAbstract },
  } = opts;
  const deadline = Date.now() + budgetMs;
  const backlog = loadBacklog(dir, now());
  const stats = { backlog: backlog.length, tried: 0, enriched: 0, notFound: 0, inconclusive: 0, errors: 0, sourceCounts: {} };

  for (const { fp, meta } of backlog) {
    if (deadline - Date.now() < MIN_ITEM_MS) break;
    stats.tried++;
    const title = meta.title || path.basename(fp, '.md');
    try {
      let found = await lookups.external(meta, title, { deadline });
      let source = found.source;
      let inconclusive = !found.abstract && found.inconclusive;
      if (!found.abstract) {
        const pdf = await lookups.pdf(meta, { deadline });
        if (pdf.abstract) {
          found = pdf;
          source = 'pdf_extraction';
        } else if (pdf.inconclusive) {
          inconclusive = true;
        }
      }

      // Re-read: a sync may have rewritten the file while the lookup ran.
      const text = fs.readFileSync(fp, 'utf-8');
      const current = parseFrontMatter(text);
      if (!current || hasAbstract(current.body)) continue;
      if (found.abstract) {
        if (!dryRun) fs.writeFileSync(fp, applyAbstract(text, found.abstract, source), 'utf-8');
        stats.enriched++;
        stats.sourceCounts[source] = (stats.sourceCounts[source] || 0) + 1;
        process.stderr.write(`  ✓ [${source.padEnd(14)}] ${title.slice(0, 60)}\n`);
      } else {
        const result = inconclusive ? 'inconclusive' : 'not_found';
        if (!dryRun) fs.writeFileSync(fp, recordLookup(text, now(), result), 'utf-8');
        stats[inconclusive ? 'inconclusive' : 'notFound']++;
        process.stderr.write(`  ${inconclusive ? '?' : '–'} ${result.padEnd(16)} ${title.slice(0, 60)}\n`);
      }
    } catch (err) {
      stats.errors++;
      process.stderr.write(`  ✗ error: ${err.message} — ${title.slice(0, 50)}\n`);
      // Mark it so a repeatable failure cannot hold the head of the queue.
      try {
        if (!dryRun) fs.writeFileSync(fp, recordLookup(fs.readFileSync(fp, 'utf-8'), now(), 'inconclusive'), 'utf-8');
      } catch {}
    }
  }
  return stats;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  const { values: args } = parseArgs({
    options: {
      dir: { type: 'string' },
      'budget-seconds': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'retry-not-found': { type: 'boolean', default: false },
    },
    strict: false,
  });
  const dir = args.dir || '/workspace/agent/zotero-md';
  const budgetSeconds = parseFloat(args['budget-seconds'] || '') || DEFAULT_BUDGET_SECONDS;
  if (args['retry-not-found'] && !args['dry-run']) {
    process.stderr.write(`Forgot ${forgetNotFound(dir)} not_found records\n`);
  }
  const stats = await runBacklogPass(dir, { budgetMs: budgetSeconds * 1000, dryRun: args['dry-run'] });
  process.stderr.write(
    `${args['dry-run'] ? '[DRY RUN] ' : ''}Backlog ${stats.backlog}: tried ${stats.tried}, enriched ${stats.enriched}, ` +
      `not found ${stats.notFound}, inconclusive ${stats.inconclusive}, errors ${stats.errors}\n`,
  );
  console.log(JSON.stringify(stats));
}
