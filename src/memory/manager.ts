/**
 * MemoryIndexManager — per-group file watcher + sync + embed coordinator.
 *
 * One instance per agent group. Watches groups/<folder>/memory/ for .md/.org changes,
 * chunks and embeds new/changed files, writes to a per-group index.db for search.
 *
 * The index.db is mounted read-only into agent containers at /workspace/memory/
 * so agents can query it directly via the memory MCP tools (bun:sqlite FTS5).
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import parcelWatcher from '@parcel/watcher';

import { log } from '../log.js';
import { MEMORY_CONFIG } from './config.js';
import { handleWorkspaceFileChanged, handleWorkspaceFileRemoved } from './rules.js';
import { chunkFile, type MemoryChunk } from './chunking.js';
import { createGeminiEmbeddingProvider, DEFAULT_GEMINI_EMBEDDING_MODEL, type EmbeddingProvider } from './embeddings.js';
import { isEmbeddingRateLimitError } from './embedding-errors.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import {
  openIndexDb,
  getCachedEmbedding,
  saveCachedEmbedding,
  deleteFileChunks,
  insertChunk,
  upsertFileRecord,
  searchIndex,
  type IndexDb,
  type SearchResult,
} from './index-db.js';

const ALLOWED_EXTENSIONS = new Set(['.md', '.org']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'venv', '__pycache__', '.venv']);
const WATCH_DEBOUNCE_MS = 3000;
const BATCH_SIZE = 100;
const CANDIDATES_MULTIPLIER = 4;
const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

export type MemorySearchResult = SearchResult & {
  content?: string;
  frontmatter?: Record<string, unknown>;
};

export function parseFrontmatterYaml(content: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match || !match[1]) return undefined;
  const result: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      result[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (raw === 'null' || raw === '') {
      result[key] = null;
    } else if (raw === 'true') {
      result[key] = true;
    } else if (raw === 'false') {
      result[key] = false;
    } else {
      result[key] = raw;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function walkDir(dir: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walkDir(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    files.push(full);
  }
}

async function listMemoryFiles(memoryDir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const stat = await fs.lstat(memoryDir);
    if (!stat.isSymbolicLink() && stat.isDirectory()) {
      await walkDir(memoryDir, result);
    }
  } catch {}
  return result;
}

function hashFile(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class MemoryIndexManager {
  private index!: IndexDb;
  private provider!: EmbeddingProvider;
  private rateLimiter!: TokenBucketRateLimiter;
  private watchers: parcelWatcher.AsyncSubscription[] = [];
  private dirty = false;
  private syncLock: Promise<void> = Promise.resolve();
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private _syncing = false;
  private _lastSyncAt: number | null = null;

  constructor(
    private readonly groupId: string,
    private readonly groupFolder: string,
    private readonly memoryDir: string,
    private readonly dbPath: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async init(): Promise<void> {
    fsSync.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.index = await openIndexDb(this.dbPath, this.model);

    const { provider } = { provider: createGeminiEmbeddingProvider({ apiKey: this.apiKey, model: this.model }) };
    this.provider = provider;

    this.rateLimiter = new TokenBucketRateLimiter({
      accountKey: hashFile(this.apiKey).slice(0, 16),
      rpmLimit: MEMORY_CONFIG.embedding_rpm_limit,
      tpmLimit: MEMORY_CONFIG.embedding_tpm_limit,
      rpdSessionBudget: MEMORY_CONFIG.embedding_rpd_budget,
    });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const markDirty = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.dirty = true;
        void this.sync();
      }, WATCH_DEBOUNCE_MS);
    };

    try {
      const sub = await parcelWatcher.subscribe(this.memoryDir, (err: Error | null, events: parcelWatcher.Event[]) => {
        if (err) return;
        const relevant = events.some((e) => !e.path.split(path.sep).some((part: string) => IGNORED_DIRS.has(part)));
        if (relevant) markDirty();
      });
      this.watchers.push(sub);
    } catch (err) {
      log.warn('Memory watcher failed to start', { groupId: this.groupId, err });
    }

    // Periodic sync every 24h in case watcher misses events
    this.periodicTimer = setInterval(
      () => {
        this.dirty = true;
        void this.sync();
      },
      24 * 60 * 60 * 1000,
    );

    // Force initial sync
    this.dirty = true;
    void this.sync({ force: true });

    log.info('Memory index manager initialized', { groupId: this.groupId, memoryDir: this.memoryDir });
  }

  async sync(opts?: { force?: boolean }): Promise<void> {
    const force = opts?.force ?? false;
    this.syncLock = this.syncLock.then(() => this._doSync(force)).catch(() => {});
    return this.syncLock;
  }

  private async _doSync(force: boolean): Promise<void> {
    if (!force && !this.dirty) return;
    this.dirty = false;
    this._syncing = true;

    const files = await listMemoryFiles(this.memoryDir);
    log.info('Memory sync: starting', { groupId: this.groupId, count: files.length, force });

    let indexed = 0,
      skipped = 0,
      removed = 0;
    let consecutiveRlFailures = 0;
    const MAX_CONSECUTIVE_RL = 3;
    const seenPaths = new Set<string>();

    for (const absPath of files) {
      if (this.closed) break;

      let content: string;
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absPath);
        content = await fs.readFile(absPath, 'utf-8');
      } catch {
        continue;
      }

      // Repo-relative path: groups/<folder>/memory/...
      const repoPath = path.relative(path.resolve('.'), absPath).replace(/\\/g, '/');
      seenPaths.add(repoPath);

      const contentHash = hashFile(content);

      // Update central DB (spec compliance)
      handleWorkspaceFileChanged({ group_id: this.groupId, path: repoPath, content_hash: contentHash });

      // Check if already indexed with same hash
      const existing = this.index.db.prepare('SELECT hash FROM files WHERE path = ?').get(repoPath) as
        | { hash: string }
        | undefined;
      if (existing?.hash === contentHash && !force) {
        skipped++;
        continue;
      }

      const chunks = chunkFile(absPath, content, {
        tokens: MEMORY_CONFIG.chunk_tokens,
        overlap: MEMORY_CONFIG.chunk_overlap_tokens,
      });
      if (chunks.length === 0) continue;

      // Check embedding cache, collect uncached chunks
      const toEmbed: Array<{ chunk: MemoryChunk; idx: number }> = [];
      const embeddings: (number[] | null)[] = new Array(chunks.length).fill(null);

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        if (!chunk) continue;
        const cached = getCachedEmbedding(this.index.db, this.model, chunk.hash);
        if (cached) {
          embeddings[ci] = cached;
        } else {
          toEmbed.push({ chunk, idx: ci });
        }
      }

      const toEmbedFiltered = toEmbed.filter((e) => e.chunk.text.trim().length > 0);

      if (toEmbedFiltered.length > 0) {
        for (let b = 0; b < toEmbedFiltered.length; b += BATCH_SIZE) {
          if (this.closed) break;
          const batch = toEmbedFiltered.slice(b, b + BATCH_SIZE);
          const texts = batch.map((e) => e.chunk.text);
          const estimatedTokens = Math.ceil(texts.reduce((s, t) => s + t.length, 0) / 4);
          try {
            await this.rateLimiter.acquirePermit(1, 600_000, estimatedTokens);
            const vecs = await this.provider.embedBatch(texts);
            for (let j = 0; j < batch.length; j++) {
              const item = batch[j];
              const vec = vecs[j];
              if (!item || !vec) continue;
              embeddings[item.idx] = vec;
              saveCachedEmbedding(this.index.db, this.model, item.chunk.hash, vec);
            }
            consecutiveRlFailures = 0;
          } catch (err) {
            if (isEmbeddingRateLimitError(err) && err.quotaType === 'rpd') {
              log.warn('Memory sync: RPD exhausted, stopping for this session', { groupId: this.groupId });
              this.rateLimiter.depleteQuotaForType('rpd');
              this.dirty = true;
              this._syncing = false;
              return;
            }
            if (isEmbeddingRateLimitError(err)) {
              this.rateLimiter.depleteQuotaForType(err.quotaType, err.retryDelayMs);
              consecutiveRlFailures++;
              if (consecutiveRlFailures >= MAX_CONSECUTIVE_RL) {
                log.warn('Memory sync: too many consecutive 429s, stopping', {
                  groupId: this.groupId,
                  consecutiveRlFailures,
                });
                this.dirty = true;
                this._syncing = false;
                return;
              }
            }
            log.warn('Memory sync: embedding batch failed, skipping file', {
              groupId: this.groupId,
              err,
              file: absPath,
            });
            break;
          }
        }
      }

      deleteFileChunks(this.index.db, repoPath, this.index.vecAvailable);

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const vec = embeddings[ci];
        if (!chunk || !vec) continue;
        const chunkId = `${repoPath}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`;
        insertChunk(this.index.db, {
          id: chunkId,
          path: repoPath,
          source: 'memory',
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash: chunk.hash,
          model: this.model,
          text: chunk.text,
          embedding: vec,
          vecAvailable: this.index.vecAvailable,
        });
      }

      upsertFileRecord(this.index.db, {
        path: repoPath,
        source: 'memory',
        hash: contentHash,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
      indexed++;
    }

    // Remove stale files no longer on disk
    const allPaths = (this.index.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map(
      (r) => r.path,
    );
    for (const p of allPaths) {
      if (!seenPaths.has(p)) {
        deleteFileChunks(this.index.db, p, this.index.vecAvailable);
        this.index.db.prepare('DELETE FROM files WHERE path = ?').run(p);
        handleWorkspaceFileRemoved({ group_id: this.groupId, path: p });
        removed++;
      }
    }

    this._syncing = false;
    this._lastSyncAt = Date.now();
    log.info('Memory sync complete', { groupId: this.groupId, indexed, skipped, removed });
  }

  /** Full hybrid search (vector + FTS5). Called by host-side memory_hybrid_search. */
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      pathPrefix?: string;
      source?: string;
      includeContent?: boolean;
    },
  ): Promise<MemorySearchResult[]> {
    if (!query.trim() || this.closed) return [];

    // Trigger background sync if dirty; search on current state immediately.
    if (this.dirty) void this.sync();

    let queryVec: number[] = [];
    try {
      await this.rateLimiter.acquirePermit(1);
      queryVec = await this.provider.embedQuery(query);
    } catch (err) {
      log.warn('Memory search: query embed failed, falling back to FTS', { groupId: this.groupId, err });
    }

    const maxResults = opts?.maxResults ?? MEMORY_CONFIG.search_top_k;
    const minScore = opts?.minScore ?? MEMORY_CONFIG.min_search_score;
    const includeContent = opts?.includeContent ?? false;
    const limited = Math.min(maxResults, includeContent ? 10 : maxResults);

    const results = searchIndex(this.index, query, queryVec, {
      limit: limited,
      minScore,
      pathPrefix: opts?.pathPrefix,
      source: opts?.source,
      vectorWeight: VECTOR_WEIGHT,
      textWeight: TEXT_WEIGHT,
      candidatesMultiplier: CANDIDATES_MULTIPLIER,
    });

    if (!includeContent) return results;

    return Promise.all(
      results.map(async (r) => {
        const result: MemorySearchResult = { ...r };
        try {
          const absPath = path.resolve(this.memoryDir, '..', r.path.replace(`groups/${this.groupFolder}/`, ''));
          const content = await fs.readFile(absPath, 'utf-8');
          result.content = content;
          result.frontmatter = parseFrontmatterYaml(content);
        } catch {}
        return result;
      }),
    );
  }

  get syncing(): boolean {
    return this._syncing;
  }
  get isDirty(): boolean {
    return this.dirty;
  }
  get lastSyncAt(): number | null {
    return this._lastSyncAt;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    for (const sub of this.watchers) {
      try {
        await sub.unsubscribe();
      } catch {}
    }
    try {
      this.index.db.close();
    } catch {}
  }
}

// Module-level manager registry — one instance per group
const managers = new Map<string, MemoryIndexManager>();

export function getMemoryManager(groupId: string): MemoryIndexManager | undefined {
  return managers.get(groupId);
}

export async function ensureMemoryManager(params: {
  groupId: string;
  groupFolder: string;
  memoryDir: string;
  dbPath: string;
  apiKey: string;
  model?: string;
}): Promise<MemoryIndexManager> {
  const existing = managers.get(params.groupId);
  if (existing) return existing;

  const manager = new MemoryIndexManager(
    params.groupId,
    params.groupFolder,
    params.memoryDir,
    params.dbPath,
    params.apiKey,
    params.model ?? DEFAULT_GEMINI_EMBEDDING_MODEL,
  );
  await manager.init();
  managers.set(params.groupId, manager);
  return manager;
}

export async function closeAllMemoryManagers(): Promise<void> {
  await Promise.all(Array.from(managers.values()).map((m) => m.close()));
  managers.clear();
}

/** Initialise memory managers for all existing agent groups. */
export async function initMemoryManagers(params: {
  dataDir: string;
  groupsDir: string;
  apiKey: string;
  model?: string;
  groups: Array<{ id: string; folder: string }>;
}): Promise<void> {
  if (!params.apiKey) {
    log.warn('Memory search disabled: MEMORY_SEARCH_GEMINI_API_KEY not set');
    return;
  }

  for (const group of params.groups) {
    if (group.id.startsWith('ag-specialist-')) continue;
    const memoryDir = path.join(params.groupsDir, group.folder, 'memory');
    const dbDir = path.join(params.dataDir, 'v2-memory', group.id);
    const dbPath = path.join(dbDir, 'index.db');

    await ensureMemoryManager({
      groupId: group.id,
      groupFolder: group.folder,
      memoryDir,
      dbPath,
      apiKey: params.apiKey,
      model: params.model,
    }).catch((err) => {
      log.warn('Failed to init memory manager for group', { groupId: group.id, err });
    });
  }
}

/** Create a memory manager for a newly created agent group (called from group-init). */
export async function initMemoryManagerForGroup(params: {
  dataDir: string;
  groupsDir: string;
  apiKey: string;
  model?: string;
  group: { id: string; folder: string };
}): Promise<void> {
  if (!params.apiKey) return;
  if (params.group.id.startsWith('ag-specialist-')) return;

  const { group } = params;
  const memoryDir = path.join(params.groupsDir, group.folder, 'memory');
  const dbPath = path.join(params.dataDir, 'v2-memory', group.id, 'index.db');

  await ensureMemoryManager({
    groupId: group.id,
    groupFolder: group.folder,
    memoryDir,
    dbPath,
    apiKey: params.apiKey,
    model: params.model,
  }).catch((err) => {
    log.warn('Failed to init memory manager for group', { groupId: group.id, err });
  });
}
