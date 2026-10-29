/**
 * Test seams for the Zotero scripts in container/tools/ — the code the host
 * runs as child processes for LibrarySynced and the abstract rules.
 *
 * The scripts are plain .mjs outside the TypeScript project, so they are
 * imported by path (typed here by hand). Their outbound HTTP goes through
 * `https.get` (Semantic Scholar, CrossRef, the Zotero file API) and `fetch`
 * (the sync); both are faked, so nothing leaves the machine. The fake routes
 * by URL and records every request.
 */
import { EventEmitter } from 'events';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { vi } from 'vitest';

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../container/tools');

export async function loadTool<T>(name: string): Promise<T> {
  const file = path.join(TOOLS_DIR, name);
  return (await import(file)) as T;
}

// ── Typings for the parts of the scripts the suite drives ───────────────────

export interface Parsed {
  meta: Record<string, string>;
  body: string;
}

export interface Frontmatter {
  MIN_ABSTRACT: number;
  MAX_ABSTRACT: number;
  RETRY_INTERVAL_DAYS: number;
  parseFrontMatter(text: string): Parsed | null;
  validateAbstract(text: string | null | undefined): string | null;
  hasAbstract(body: string): boolean;
  parseLookup(meta: Record<string, string> | undefined): { at: string; result: string } | null;
  recordLookup(text: string, now: Date, result: string): string;
  applyAbstract(text: string, abstract: string, source: string): string;
  inBacklog(parsed: Parsed | null, now: Date, retryDays?: number): boolean;
  prioritiseBacklog<E extends { meta: Record<string, string> }>(entries: E[]): E[];
}

export interface LookupResult {
  abstract: string | null;
  source?: string;
  inconclusive?: boolean;
  reason?: string;
}

export interface Lookups {
  external(meta: Record<string, string>, title: string, opts: { deadline: number }): Promise<LookupResult>;
  pdf(meta: Record<string, string>, opts: { deadline: number }): Promise<LookupResult>;
}

export interface PassStats {
  backlog: number;
  tried: number;
  enriched: number;
  notFound: number;
  inconclusive: number;
  errors: number;
  sourceCounts: Record<string, number>;
}

export interface Abstracts {
  forgetNotFound(dir: string): number;
  runBacklogPass(
    dir: string,
    opts?: { budgetMs?: number; dryRun?: boolean; now?: () => Date; lookups?: Lookups },
  ): Promise<PassStats>;
}

export interface Enrich {
  findAbstract(
    meta: Record<string, string>,
    title: string,
    opts?: { deadline?: number },
  ): Promise<{ abstract: string | null; source?: string; inconclusive?: boolean }>;
}

export interface Extract {
  findPdfAbstract(meta: Record<string, string>, opts?: { deadline?: number; maxMb?: number }): Promise<LookupResult>;
  _resetZoteroBackoff(): void;
}

export interface SyncResult {
  newCount: number;
  deletedCount: number;
  newVersion: number;
  totalItems: number;
  items: Array<{ key: string; title: string }>;
}

export interface Sync {
  syncLibrary(opts: {
    since: number;
    output: string;
    stateFile: string;
    apiBase: string;
    userId: string;
    apiKey: string;
  }): Promise<SyncResult>;
}

// ── Fake https.get ──────────────────────────────────────────────────────────

export interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export const net = {
  /** Answer for a URL; undefined = 404. An Error is a network failure. */
  route: (() => undefined) as (url: string) => FakeResponse | Error | undefined,
  requests: [] as string[],
  reset(): void {
    this.route = () => undefined;
    this.requests = [];
  },
};

function get(url: string, opts: unknown, cb?: (res: Readable) => void): EventEmitter {
  const callback = typeof opts === 'function' ? (opts as (res: Readable) => void) : cb!;
  const req = Object.assign(new EventEmitter(), {
    setTimeout: () => req,
    destroy: (err?: Error) => {
      if (err) req.emit('error', err);
      return req;
    },
  });
  net.requests.push(url);
  setImmediate(() => {
    const answer = net.route(url) ?? { status: 404, body: '' };
    if (answer instanceof Error) {
      req.emit('error', answer);
      return;
    }
    const res = Object.assign(Readable.from([Buffer.from(answer.body ?? '')]), {
      statusCode: answer.status,
      headers: answer.headers ?? {},
    });
    callback(res);
  });
  return req;
}

export const httpsMock = { default: { get }, get };

export const json = (data: unknown, status = 200): FakeResponse => ({ status, body: JSON.stringify(data) });

/**
 * The scripts pause 1 s between requests (politeness to S2, CrossRef and
 * Zotero). Run those pauses at once; budgets are measured with Date.now and
 * are unaffected.
 */
export function fastPauses(): void {
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
    (real as (...a: unknown[]) => unknown)(
      fn,
      ms !== undefined && ms >= 1000 && ms <= 3000 ? 0 : ms,
      ...rest,
    )) as unknown as typeof setTimeout);
}

// ── Item files ──────────────────────────────────────────────────────────────

/** A synced item file as zotero-sync.mjs writes it, with no abstract. */
export function itemFile(key: string, extra: Record<string, string> = {}, abstract?: string): string {
  const fm = [`title: Paper ${key}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), `zoteroKey: ${key}`];
  return `---\n${fm.join('\n')}\n---\n\n# Paper ${key}\n\n**Author, A (2020)**\n${abstract ? `\n${abstract}\n` : ''}`;
}

/** Prose of exactly `n` characters, ending in a letter. */
export function words(n: number): string {
  const text = Array.from({ length: Math.ceil(n / 6) + 1 }, (_, i) => `word${i % 10}`)
    .join(' ')
    .slice(0, n);
  return text.endsWith(' ') ? `${text.slice(0, -1)}x` : text;
}
