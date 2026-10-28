#!/usr/bin/env node
/**
 * Zotero library sync — fetches items from Zotero API and writes markdown files.
 *
 * Usage: node zotero-sync.mjs --since VERSION --output DIR [--state FILE]
 * Env:   ZOTERO_API_KEY, ZOTERO_USER_ID, ZOTERO_API_BASE (optional)
 *
 * Run by the host (src/modules/zotero/sync.ts), which holds the credentials.
 *
 * Outputs a JSON summary to stdout:
 *   { newCount, deletedCount, newVersion, totalItems, items: [{key, title}] }
 *
 * Also writes the state file (--state; default /workspace/agent/zotero-state.json)
 * with the full sync result, which the host merges into its sync state.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let since = 0;
  let output = '/workspace/agent/zotero-md';
  let state = '/workspace/agent/zotero-state.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since') since = parseInt(args[++i], 10) || 0;
    else if (args[i] === '--output') output = args[++i];
    else if (args[i] === '--state') state = args[++i];
  }
  return { since, output, state };
}

function getCredentials() {
  const apiKey = process.env.ZOTERO_API_KEY;
  const userId = process.env.ZOTERO_USER_ID;
  if (!apiKey || !userId) {
    throw new Error('ZOTERO_API_KEY and ZOTERO_USER_ID must be set');
  }
  return { apiKey, userId };
}

const SYNC_REQUEST_TIMEOUT_MS = 30_000;

// ── Zotero API helpers ────────────────────────────────────────────────────────

async function fetchZotero(url, apiKey) {
  const response = await fetch(url, {
    headers: {
      'Zotero-API-Key': apiKey,
      'Zotero-API-Version': '3',
    },
    signal: AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Zotero API error: HTTP ${response.status} for ${url}`);
  }
  const version = parseInt(
    response.headers.get('Last-Modified-Version') || '0',
    10,
  );
  const data = await response.json();
  return { data, version };
}

async function fetchAllPages(baseUrl, apiKey) {
  let start = 0;
  const limit = 100;
  const allItems = [];
  let newVersion = 0;

  while (true) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}limit=${limit}&start=${start}`;
    const { data, version } = await fetchZotero(url, apiKey);
    newVersion = version;
    if (!Array.isArray(data) || data.length === 0) break;
    allItems.push(...data);
    if (data.length < limit) break;
    start += limit;
  }

  return { items: allItems, newVersion };
}

// ── Markdown generation ───────────────────────────────────────────────────────

function formatCreators(creators) {
  if (!Array.isArray(creators) || creators.length === 0) return '';
  const authors = creators.filter(
    (c) => c.creatorType === 'author' || creators.length === 1,
  );
  return (authors.length ? authors : creators)
    .map((c) =>
      c.lastName ? `${c.lastName}, ${(c.firstName || '').trim()}`.trim() : (c.name || ''),
    )
    .filter(Boolean)
    .join('; ');
}

function extractYear(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/\d{4}/);
  return m ? m[0] : '';
}

function buildMarkdown(item) {
  const d = item.data;
  const title = (d.title || '(no title)').replace(/:/g, '：');
  const authors = formatCreators(d.creators);
  const year = extractYear(d.date);
  const doi = d.DOI || '';
  const url = d.url || '';
  const abstract = d.abstractNote || '';
  const tags = Array.isArray(d.tags)
    ? d.tags
        .map((t) => t.tag)
        .filter(Boolean)
        .join(', ')
    : '';
  const itemType = d.itemType || '';

  const frontmatterLines = [
    '---',
    `title: ${title}`,
    authors ? `authors: ${authors}` : null,
    year ? `year: ${year}` : null,
    doi ? `doi: ${doi}` : null,
    url ? `url: ${url}` : null,
    `itemType: ${itemType}`,
    `zoteroKey: ${item.key}`,
    tags ? `tags: ${tags}` : null,
    '---',
  ].filter(Boolean);

  const bodyLines = [
    `# ${title}`,
    '',
    authors && year
      ? `**${authors} (${year})**`
      : authors || year
        ? `**${authors || year}**`
        : null,
    '',
    abstract || null,
  ].filter((l) => l !== null);

  return frontmatterLines.join('\n') + '\n\n' + bodyLines.join('\n') + '\n';
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Fetch the changes since `since`, apply them to `output`, and record the
 * result in `stateFile`. Throws on any API failure before touching a file —
 * the deletions included: a run that skipped them but still advanced the
 * version would never ask for them again, and the deleted items' files would
 * stay (and stay searchable) for good. A failed run writes no state, so the
 * host keeps its version and the next check retries the whole sync.
 */
export async function syncLibrary({ since, output, stateFile, apiBase, userId, apiKey }) {
  const base = `${apiBase}/users/${userId}`;

  // Fetch new/modified items (exclude attachments)
  const sinceParam = since > 0 ? `&since=${since}` : '';
  const itemsUrl = `${base}/items?format=json&itemType=-attachment${sinceParam}`;
  const { items, newVersion } = await fetchAllPages(itemsUrl, apiKey);

  // Fetch deletions (only meaningful when we have a baseline version)
  let deletedKeys = [];
  if (since > 0) {
    const { data: deleted } = await fetchZotero(`${base}/deleted?since=${since}`, apiKey);
    deletedKeys = Array.isArray(deleted.items) ? deleted.items : [];
  }

  fs.mkdirSync(output, { recursive: true });

  // Write markdown for new/modified items
  const writtenItems = [];
  for (const item of items) {
    const filepath = path.join(output, `${item.key}.md`);
    fs.writeFileSync(filepath, buildMarkdown(item), 'utf-8');
    writtenItems.push({ key: item.key, title: item.data.title || '(no title)' });
  }

  // Remove deleted item files
  let deleteCount = 0;
  for (const key of deletedKeys) {
    const filepath = path.join(output, `${key}.md`);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      deleteCount++;
    }
  }

  const totalItems = fs.readdirSync(output).filter((f) => f.endsWith('.md')).length;
  const lastSync = new Date().toISOString();

  // Write extended state file so the host process can update its DB and
  // send notifications with the right change counts and item titles.
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      newVersion,
      totalItems,
      lastSync,
      newCount: items.length,
      deletedCount: deleteCount,
      addedItems: writtenItems.slice(0, 20),
    }),
    'utf-8',
  );

  return {
    newCount: items.length,
    deletedCount: deleteCount,
    newVersion,
    totalItems,
    items: writtenItems.slice(0, 20),
  };
}

async function main() {
  const { since, output, state } = parseArgs();
  const { apiKey, userId } = getCredentials();
  const result = await syncLibrary({
    since,
    output,
    stateFile: state,
    apiBase: process.env.ZOTERO_API_BASE || 'https://api.zotero.org',
    userId,
    apiKey,
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`zotero-sync error: ${err.message}\n`);
    process.exit(1);
  });
}
