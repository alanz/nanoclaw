import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

import { GROUPS_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const SYNC_STATE_FILE = 'zotero-state.json';

export interface ZoteroSyncResult {
  newVersion: number;
  totalItems: number;
  lastSync: string;
  newCount: number;
  deletedCount: number;
  addedItems: Array<{ key: string; title: string }>;
}

/**
 * Read the sync result written by zotero-sync.mjs.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readSyncResult(agentGroupFolder: string): ZoteroSyncResult | null {
  const filePath = path.join(GROUPS_DIR, agentGroupFolder, SYNC_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ZoteroSyncResult;
  } catch {
    return null;
  }
}

// The scripts run on the host (zotero.allium): it holds the Zotero key, and
// zotero-md is written only here — every container mounts it read-only. They
// were an agent prompt whose one job was to run the sync script, at ~50k
// tokens of context a time, from whichever session of the group had no
// messaging group.
const TOOLS_DIR = path.join(process.cwd(), 'container', 'tools');
const SYNC_TIMEOUT_MS = 10 * 60_000;

/** At most one Zotero script at a time: sync and enrichment both write zotero-md. */
let running: Promise<unknown> = Promise.resolve();
let busy = false;

/**
 * Run one of the container/tools Zotero scripts as a child process, with the
 * credentials in its environment and a time limit. Resolves to its JSON
 * summary (last stdout line), or null when it failed — logged, never thrown.
 */
async function runZoteroScript(script: string, args: string[], timeoutMs: number): Promise<unknown> {
  const env = readEnvFile(['ZOTERO_API_KEY', 'ZOTERO_USER_ID']);
  const run = () =>
    new Promise<unknown>((resolve) => {
      execFile(
        process.execPath,
        [path.join(TOOLS_DIR, script), ...args],
        {
          env: { ...process.env, ZOTERO_API_KEY: env.ZOTERO_API_KEY ?? '', ZOTERO_USER_ID: env.ZOTERO_USER_ID ?? '' },
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            log.warn('Zotero: script failed', { script, err: err.message, stderr: stderr.slice(-2000) });
            resolve(null);
            return;
          }
          const last = stdout.trim().split('\n').pop() ?? '';
          try {
            resolve(JSON.parse(last));
          } catch {
            resolve(null);
          }
        },
      );
    });
  const next = running.then(run, run);
  running = next;
  busy = true;
  try {
    return await next;
  } finally {
    if (running === next) busy = false;
  }
}

/** Whether a Zotero script is running or queued (the monitor does not stack runs). */
export function zoteroScriptBusy(): boolean {
  return busy;
}

/**
 * zotero.allium LibrarySynced: fetch what changed since lastVersion into the
 * group's zotero-md/ and write zotero-state.json, which the monitor merges
 * into the sync state on its next tick.
 */
export async function runSync(agentGroupFolder: string, lastVersion: number): Promise<void> {
  const groupDir = path.join(GROUPS_DIR, agentGroupFolder);
  fs.mkdirSync(path.join(groupDir, 'zotero-md'), { recursive: true });
  const result = await runZoteroScript(
    'zotero-sync.mjs',
    [
      '--since',
      String(lastVersion),
      '--output',
      path.join(groupDir, 'zotero-md'),
      '--state',
      path.join(groupDir, SYNC_STATE_FILE),
    ],
    SYNC_TIMEOUT_MS,
  );
  log.info('Zotero sync run finished', { lastVersion, result });
}

// zotero.allium config: abstract_retry_interval, enrichment_run_budget. A pass
// is kept short: hourly passes drain the backlog a little at a time.
const ABSTRACT_RETRY_MS = 180 * 86_400_000;
export const ENRICHMENT_RUN_BUDGET_SECONDS = 25;
const LOOKUP_RE = /^abstract_lookup: (\S+) (not_found|inconclusive)\s*$/m;

/**
 * Whether one item file is in the enrichment backlog: no abstract, and not a
 * not_found lookup younger than the retry interval. Mirrors inBacklog in
 * container/tools/zotero-frontmatter.mjs (host and container share no code).
 */
export function itemInBacklog(text: string, now: Date): boolean {
  if (!text.startsWith('---')) return false;
  const nl = text.indexOf('\n');
  const end = text.indexOf('\n---', nl + 1);
  if (nl < 0 || end < 0) return false;
  const bodyStart = end + 4 + (text[end + 4] === '\n' ? 1 : 0);
  // Has an abstract: text beyond the `# title` heading and the bold
  // author/year line, which an item with neither authors nor a year lacks.
  const bodyLines = text
    .slice(bodyStart)
    .split('\n')
    .filter((l) => l.trim());
  let i = 0;
  if (bodyLines[i]?.startsWith('# ')) i++;
  if (bodyLines[i] && /^\*\*[^\n]*\*\*$/.test(bodyLines[i].trim())) i++;
  if (i < bodyLines.length) return false;
  const lookup = text.slice(nl + 1, end).match(LOOKUP_RE);
  if (!lookup || lookup[2] !== 'not_found') return true;
  const at = Date.parse(lookup[1]);
  return Number.isNaN(at) || now.getTime() - at >= ABSTRACT_RETRY_MS;
}

/** Item keys in the backlog, optionally limited to `keys`. */
export function enrichmentBacklog(agentGroupFolder: string, now = new Date(), keys?: string[]): string[] {
  const dir = path.join(GROUPS_DIR, agentGroupFolder, 'zotero-md');
  let names: string[];
  try {
    names = keys ? keys.map((k) => `${k}.md`) : fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      return itemInBacklog(fs.readFileSync(path.join(dir, name), 'utf-8'), now) ? [name.slice(0, -3)] : [];
    } catch {
      return [];
    }
  });
}

/**
 * zotero.allium EnrichmentRun: one budgeted lookup pass over the backlog,
 * writing its results into the item files. retryNotFound first forgets every
 * not_found record (EnrichmentTriggeredOnRequest).
 */
export async function runEnrichment(
  agentGroupFolder: string,
  opts: { retryNotFound?: boolean } = {},
): Promise<unknown> {
  const dir = path.join(GROUPS_DIR, agentGroupFolder, 'zotero-md');
  const result = await runZoteroScript(
    'zotero-abstracts.mjs',
    [
      '--dir',
      dir,
      '--budget-seconds',
      String(ENRICHMENT_RUN_BUDGET_SECONDS),
      ...(opts.retryNotFound ? ['--retry-not-found'] : []),
    ],
    (ENRICHMENT_RUN_BUDGET_SECONDS + 30) * 1000,
  );
  log.info('Zotero enrichment run finished', { result });
  return result;
}
