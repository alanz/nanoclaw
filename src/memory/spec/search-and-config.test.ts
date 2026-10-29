/**
 * Value-type and config obligations propagated from specs/memory.allium:
 * MemorySearchResult, MemorySearchLocation, MemorySearchParams and the config
 * block. Each config default is checked where it takes effect — the search
 * floor, weights, result and location caps, the embedding wait, the limiter
 * the indexer draws on, the refusal cap, the periodic sync — through the real
 * MemoryIndexManager, index and host search (handleMemorySearch). Only the
 * embedding provider, the shared rate limiter and the native watcher are
 * faked; a chunk's vector score is set by a `cos=<n>` marker in its text (see
 * fixtures.ts).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import type { Ctl } from './fixtures.js';

const ctl = vi.hoisted(() => ({}) as Ctl);

vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../embeddings.js', async () => {
  const { fakeProvider } = await import('./fixtures.js');
  return {
    DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
    createGeminiEmbeddingProvider: () => fakeProvider(ctl),
  };
});
vi.mock('../rate-limiter.js', async (importOriginal) => {
  const { fakeLimiter } = await import('./fixtures.js');
  return {
    ...(await importOriginal<typeof import('../rate-limiter.js')>()),
    sharedRateLimiter: (config: unknown) => {
      ctl.limiterConfigs.push(config);
      return fakeLimiter(ctl);
    },
  };
});
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));
vi.mock('../index-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index-db.js')>();
  return { ...actual, searchIndex: vi.fn(actual.searchIndex) };
});

import { MEMORY_CONFIG } from '../config.js';
import { EmbeddingRateLimitError } from '../embedding-errors.js';
import { searchIndex } from '../index-db.js';
import { closeAllMemoryManagers, ensureMemoryManager, type MemoryIndexManager } from '../manager.js';
import { handleMemorySearch } from '../search.js';
import { readIndex, resetCtl, settled, tempRoot, writeFile, FINGERPRINT_KEY } from './fixtures.js';
import { covered, obligation } from './harness.js';

const GROUP = 'ag-main';
const FOLDER = 'main';
const SESSION = { id: 'sess-main', agent_group_id: GROUP };
let cwd: string;
let root: string;
let groupDir: string;
let dbPath: string;

beforeEach(() => {
  resetCtl(ctl);
  vi.mocked(searchIndex).mockClear();
  cwd = process.cwd();
  root = tempRoot('memory-spec-search-');
  process.chdir(root);
  groupDir = path.join(root, 'groups', FOLDER);
  fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
  dbPath = path.join(root, 'data', 'v2-memory', GROUP, 'index.db');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeAllMemoryManagers();
  process.chdir(cwd);
  fs.rmSync(root, { recursive: true, force: true });
});

const MEM = `groups/${FOLDER}/memory`;
const put = (rel: string, content: string) => writeFile(path.join(root, rel), content);

async function start(): Promise<MemoryIndexManager> {
  const m = await ensureMemoryManager({
    groupId: GROUP,
    groupFolder: FOLDER,
    memoryDir: path.join(groupDir, 'memory'),
    dbPath,
    apiKey: 'test-key',
  });
  await settled(m);
  return m;
}

type Result = {
  path: string;
  source: string;
  score: number;
  locations: Array<{ startLine: number; endLine: number; score: number; snippet: string }>;
  moreLocations: number;
  content?: string;
};

async function search(query: string, extra: Partial<Parameters<typeof handleMemorySearch>[0]> = {}) {
  const r = await handleMemorySearch({ session: SESSION, group_id: GROUP, query, ...extra });
  return { mode: r.mode, results: r.results as Result[] };
}

/** A file whose lines 10, 110, 210, … mention zebras: chunks far enough apart not to merge. */
function zebraFile(mentions: number): string {
  return Array.from({ length: mentions * 100 }, (_, i) =>
    i % 100 === 9 ? `Line ${i}: a zebra crossed here.` : `Line ${i}: nothing of note happened today.`,
  ).join('\n');
}

const lastSearchOpts = () => vi.mocked(searchIndex).mock.calls.at(-1)![3];

// ── Value types ──────────────────────────────────────────────────────────────

obligation('value-equality.MemorySearchResult', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks dig burrows.\n');
  put(`${MEM}/b.md`, '# B\n\nAardvarks and badgers.\n');
  await start();
  const first = await search('aardvarks');
  const second = await search('aardvarks');
  expect(first.results).toHaveLength(2);
  // Values, not identities: the same search gives equal, separate results.
  expect(second.results).toEqual(first.results);
  expect(second.results[0]).not.toBe(first.results[0]);
  expect(JSON.parse(JSON.stringify(first.results))).toEqual(first.results);
});

obligation('entity-fields.MemorySearchResult', async () => {
  put(`${MEM}/z.md`, zebraFile(5));
  ctl.queryFails = true; // keyword-only: only the zebra chunks match
  await start();
  const { results } = await search('zebra');
  expect(results).toHaveLength(1);
  const [r] = results;
  expect(Object.keys(r!).sort()).toEqual(['locations', 'moreLocations', 'path', 'score', 'source']);
  expect(r!.path).toBe(`${MEM}/z.md`); // file
  expect(r!.score).toBe(Math.max(...r!.locations.map((l) => l.score))); // the best location's score
  expect(r!.locations).toHaveLength(MEMORY_CONFIG.search_locations_per_file); // at most 3
  const scores = r!.locations.map((l) => l.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a)); // best first
  expect(r!.moreLocations).toBe(2); // the matching places left out
});

obligation('value-equality.MemorySearchLocation', async () => {
  put(`${MEM}/z.md`, zebraFile(2));
  ctl.queryFails = true;
  await start();
  const a = (await search('zebra')).results[0]!.locations;
  const b = (await search('zebra')).results[0]!.locations;
  expect(a).toHaveLength(2);
  expect(b).toEqual(a);
  for (const l of a) expect(Object.keys(l).sort()).toEqual(['endLine', 'score', 'snippet', 'startLine']);
});

obligation('entity-fields.MemorySearchLocation', async () => {
  const content = zebraFile(3);
  put(`${MEM}/z.md`, content);
  ctl.queryFails = true;
  await start();
  const lines = content.split('\n');
  const [r] = (await search('zebra')).results;
  r!.locations.forEach((l, i) => {
    expect(Number.isInteger(l.startLine) && Number.isInteger(l.endLine)).toBe(true);
    expect(l.startLine).toBeLessThanOrEqual(l.endLine);
    expect(l.score).toBeGreaterThan(0);
    expect(l.score).toBeLessThanOrEqual(1);
    // snippet: an excerpt of those lines; full length (700) for the best, shorter (200) for the rest.
    const span = lines.slice(l.startLine - 1, l.endLine).join('\n');
    expect(span).toContain(l.snippet);
    expect(l.snippet.length).toBe(i === 0 ? 700 : 200);
    expect(span).toContain('zebra');
  });
});

obligation('value-equality.MemorySearchParams', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks dig burrows.\n');
  put(`groups/${FOLDER}/memory/deep/b.md`, '# B\n\nAardvarks and badgers.\n');
  await start();
  const params = { top_k: 4, path_prefix: `${MEM}/deep/`, source: 'memory', min_score: 0.2 };
  const one = await search('aardvarks', { ...params });
  const two = await search('aardvarks', JSON.parse(JSON.stringify(params)));
  expect(two).toEqual(one);
  expect(one.results.map((r) => r.path)).toEqual([`${MEM}/deep/b.md`]);
  // A different value is a different search.
  expect((await search('aardvarks', { ...params, path_prefix: `${MEM}/` })).results).toHaveLength(2);
});

obligation('entity-fields.MemorySearchParams', async () => {
  for (let i = 0; i < 4; i++) put(`${MEM}/n${i}.md`, `# N${i}\n\nAardvarks number ${i}.\n`);
  put(`groups/${FOLDER}/zettel/notes/old.md`, '---\nsuperseded_by: new.md\n---\nAardvarks, as once believed.\n');
  put(`groups/${FOLDER}/zettel/notes/low.md`, 'Aardvarks, faintly. cos=0.1\n');
  const m = await ensureMemoryManager({
    groupId: GROUP,
    groupFolder: FOLDER,
    memoryDir: path.join(groupDir, 'memory'),
    dbPath,
    apiKey: 'test-key',
    additionalDirs: [{ dir: path.join(groupDir, 'zettel'), source: 'zettel' }],
  });
  await settled(m);
  const paths = (rs: Array<{ path: string }>) => rs.map((r) => r.path).sort();

  // limit
  expect((await m.search('aardvarks', { maxResults: 2 })).results).toHaveLength(2);
  // min_score: the faint note scores 0.7*0.1 + keyword, under the default floor
  expect(paths((await m.search('aardvarks')).results)).not.toContain(`groups/${FOLDER}/zettel/notes/low.md`);
  expect(paths((await m.search('aardvarks', { minScore: 0 })).results)).toContain(
    `groups/${FOLDER}/zettel/notes/low.md`,
  );
  // path_prefix and source
  expect(paths((await m.search('aardvarks', { pathPrefix: `${MEM}/n1` })).results)).toEqual([`${MEM}/n1.md`]);
  expect(paths((await m.search('aardvarks', { source: 'zettel', minScore: 0 })).results)).toEqual([
    `groups/${FOLDER}/zettel/notes/low.md`,
  ]);
  // include_superseded
  expect(
    paths((await m.search('aardvarks', { source: 'zettel', minScore: 0, includeSuperseded: true })).results),
  ).toEqual([`groups/${FOLDER}/zettel/notes/low.md`, `groups/${FOLDER}/zettel/notes/old.md`]);
  // include_content
  const [withContent] = (await m.search('aardvarks', { pathPrefix: `${MEM}/n2`, includeContent: true })).results;
  expect(withContent!.content).toBe('# N2\n\nAardvarks number 2.\n');
  const [without] = (await m.search('aardvarks', { pathPrefix: `${MEM}/n2` })).results;
  expect(without).not.toHaveProperty('content');
});

// MemoryListParams are applied in the container, which lists the group's
// read-only index itself (memory_list_files).
covered(
  'value-equality.MemoryListParams',
  'container/agent-runner/src/mcp-tools/memory-index-reads.test.ts',
  'memory_list_files: equal list params give equal listings',
);

covered(
  'entity-fields.MemoryListParams',
  'container/agent-runner/src/mcp-tools/memory-index-reads.test.ts',
  'memory_list_files applies each list param: path_prefix, source, limit, order_by and parse_frontmatter',
);

// ── Config defaults ──────────────────────────────────────────────────────────

obligation('config-default.chunk_tokens', async () => {
  expect(MEMORY_CONFIG.chunk_tokens).toBe(400);
  // 400 tokens at 4 characters each: no chunk of a long file passes 1600 characters.
  put(`${MEM}/long.md`, Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n'));
  await start();
  const chunks = readIndex(dbPath).chunks;
  expect(chunks.length).toBeGreaterThan(5);
  for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400 * 4);
  expect(Math.max(...chunks.map((c) => c.text.length))).toBeGreaterThan(400 * 4 - 60);
  expect(JSON.parse(readIndex(dbPath).meta[FINGERPRINT_KEY]!).chunkTokens).toBe(400);
});

obligation('config-default.chunk_overlap_tokens', async () => {
  expect(MEMORY_CONFIG.chunk_overlap_tokens).toBe(80);
  put(`${MEM}/long.md`, Array.from({ length: 300 }, (_, i) => `Line ${i}: ${'x'.repeat(40)}`).join('\n'));
  await start();
  const chunks = readIndex(dbPath).chunks;
  // Each chunk carries ~80 tokens (320 characters) of the one before it.
  for (let i = 1; i < chunks.length - 1; i++) {
    const prev = chunks[i - 1]!;
    const shared = prev.text
      .split('\n')
      .slice(chunks[i]!.start_line - prev.start_line)
      .join('\n');
    expect(chunks[i]!.text.startsWith(shared)).toBe(true);
    expect(shared.length + 1).toBeGreaterThanOrEqual(80 * 4);
    expect(shared.length).toBeLessThan(80 * 4 + 60);
  }
  expect(JSON.parse(readIndex(dbPath).meta[FINGERPRINT_KEY]!).chunkOverlap).toBe(80);
});

obligation('config-default.search_top_k', async () => {
  for (let i = 0; i < 10; i++) put(`${MEM}/n${i}.md`, `# N${i}\n\nAardvarks number ${i}.\n`);
  await start();
  expect((await search('aardvarks')).results).toHaveLength(6);
  expect((await search('aardvarks', { top_k: 8 })).results).toHaveLength(8);
});

obligation('config-default.search_max_top_k', async () => {
  // Default 20: a larger top_k is capped, not refused.
  for (let i = 0; i < 25; i++) put(`${MEM}/n${i}.md`, `# N${i}\n\nAardvarks number ${i}.\n`);
  await start();
  expect((await search('aardvarks', { top_k: 20 })).results).toHaveLength(20);
  expect((await search('aardvarks', { top_k: 50 })).results).toHaveLength(20);
});

obligation('config-default.search_locations_per_file', async () => {
  put(`${MEM}/z.md`, zebraFile(7));
  ctl.queryFails = true;
  await start();
  const [r] = (await search('zebra')).results;
  expect(r!.locations).toHaveLength(3);
  expect(r!.moreLocations).toBe(4);
});

obligation('config-default.min_search_score', async () => {
  put(`${MEM}/below.md`, 'Unrelated words. cos=0.45\n');
  put(`${MEM}/above.md`, 'Unrelated words. cos=0.55\n');
  await start();
  // No keyword match: score = 0.7 * cosine; 0.315 is under the 0.35 floor, 0.385 over it.
  const { mode, results } = await search('zebra');
  expect(mode).toBe('hybrid');
  expect(results.map((r) => r.path)).toEqual([`${MEM}/above.md`]);
  expect(lastSearchOpts().minScore).toBe(0.35);
});

obligation('config-default.min_keyword_score', async () => {
  // A word in 10 of 24 files: a weak keyword match (FTS5 bm25 idf ln(14.5/10.5)).
  for (let i = 0; i < 10; i++) put(`${MEM}/z${i}.md`, `Note ${i} about the weather and the zebra herd.\n`);
  for (let i = 0; i < 14; i++) put(`${MEM}/f${i}.md`, `Filler ${i} about the weather and the horses.\n`);
  ctl.queryFails = true;
  await start();
  const { mode, results } = await search('zebra');
  expect(mode).toBe('keyword');
  expect(lastSearchOpts().minScore).toBe(0.1);
  // Scored by keyword alone: matches under the hybrid floor are still returned.
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) expect(r.score).toBeGreaterThanOrEqual(0.1);
  expect(results.some((r) => r.score < 0.35)).toBe(true);
});

// The container's wait for the host's answer, before it searches keyword-only itself.
covered(
  'config-default.search_host_timeout',
  'container/agent-runner/src/mcp-tools/memory-index-reads.test.ts',
  'memory_search waits 15 seconds for the host before searching keyword-only itself',
);

obligation(
  'config-default.search_embed_wait',
  async () => {
    put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
    for (let i = 0; i < 5; i++) put(`${MEM}/f${i}.md`, `Filler ${i}.\n`);
    await start();
    ctl.permit = () => new Promise<void>(() => {}); // cool-down: no permit comes
    const t0 = Date.now();
    const { mode, results } = await search('aardvarks');
    const waited = Date.now() - t0;
    expect(mode).toBe('keyword');
    expect(results.map((r) => r.path)).toEqual([`${MEM}/a.md`]);
    expect(waited).toBeGreaterThanOrEqual(2_900);
    expect(waited).toBeLessThan(4_500);
  },
  10_000,
);

obligation('config-default.vector_score_weight', async () => {
  put(`${MEM}/v.md`, 'Unrelated words. cos=0.8\n');
  await start();
  const [r] = (await search('zebra', { min_score: 0 })).results;
  expect(r!.score).toBeCloseTo(0.7 * 0.8, 3);
  expect(MEMORY_CONFIG.vector_score_weight).toBe(0.7);
});

obligation('config-default.keyword_score_weight', async () => {
  put(`${MEM}/k.md`, 'The zebra herd. cos=0\n');
  for (let i = 0; i < 10; i++) put(`${MEM}/f${i}.md`, `Filler ${i} about the weather. cos=0\n`);
  await start();
  const hybrid = (await search('zebra', { min_score: 0 })).results.find((r) => r.path === `${MEM}/k.md`)!;
  ctl.queryFails = true;
  const keyword = (await search('zebra', { min_score: 0 })).results.find((r) => r.path === `${MEM}/k.md`)!;
  expect(keyword.score).toBeGreaterThan(0);
  expect(hybrid.score).toBeCloseTo(0.3 * keyword.score, 6);
  expect(MEMORY_CONFIG.keyword_score_weight).toBe(0.3);
});

obligation('config-default.embedding_provider', async () => {
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  await start();
  expect(MEMORY_CONFIG.embedding_provider).toBe('gemini');
  expect(JSON.parse(readIndex(dbPath).meta[FINGERPRINT_KEY]!).provider).toBe('gemini');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  expect(db.prepare('SELECT DISTINCT provider FROM embedding_cache').all()).toEqual([{ provider: 'gemini' }]);
  db.close();
});

obligation('config-default.embedding_rpm_limit', async () => {
  await start();
  expect(ctl.limiterConfigs).toEqual([expect.objectContaining({ rpmLimit: 50 })]);
});

obligation('config-default.embedding_tpm_limit', async () => {
  // ~50 chunks of ~400 tokens: more than one minute's tokens, so batches are cut by tokens.
  put(`${MEM}/big.md`, Array.from({ length: 2200 }, (_, i) => `Line ${i}: ${'y'.repeat(30)}`).join('\n'));
  await start();
  expect(ctl.limiterConfigs).toEqual([expect.objectContaining({ tpmLimit: 15_000 })]);
  expect(ctl.batches.length).toBeGreaterThan(1);
  for (const b of ctl.batches) expect(b.reduce((s, t) => s + Math.ceil(t.length / 4), 0)).toBeLessThanOrEqual(15_000);
});

obligation('config-default.embedding_rpd_budget', async () => {
  await start();
  expect(ctl.limiterConfigs).toEqual([expect.objectContaining({ rpdSessionBudget: 900 })]);
});

obligation('config-default.embedding_max_consecutive_refusals', async () => {
  for (let i = 0; i < 6; i++) put(`${MEM}/n${i}.md`, `# N${i}\n\nNote ${i}.\n`);
  // Two refusals, a success, then refusals: the pass ends at the third in a row.
  let call = 0;
  ctl.batchError = () => (++call === 3 ? undefined : new EmbeddingRateLimitError('429', 'rpm', null));
  const m = await start();
  expect(ctl.batches).toHaveLength(6);
  expect(m.stats()?.lastSync).toMatchObject({ outcome: 'interrupted', indexed: 1 });
  expect(readIndex(dbPath).files).toHaveLength(1);
});

obligation('config-default.periodic_sync_interval', async () => {
  const intervals: Array<{ ms: number; fn: () => void }> = [];
  const real = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
    intervals.push({ fn, ms });
    return real(() => {}, 1 << 30);
  }) as typeof setInterval);
  put(`${MEM}/a.md`, '# A\n\nAardvarks.\n');
  const m = await start();
  const periodic = intervals.filter((i) => i.ms === 24 * 60 * 60 * 1000);
  expect(periodic).toHaveLength(1);

  // With no watcher event, the periodic run alone picks up a new file.
  put(`${MEM}/b.md`, '# B\n\nBadgers.\n');
  periodic[0]!.fn();
  await settled(m);
  expect(readIndex(dbPath).files.map((f) => f.path)).toEqual([`${MEM}/a.md`, `${MEM}/b.md`]);
});
