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

import type { AdditionalMountConfig } from '../container-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import { validateMount } from '../modules/mount-security/index.js';
import { MEMORY_CONFIG } from './config.js';

/**
 * Groups that must not be indexed.
 *
 * Specialist groups are ephemeral workers whose `memory/` is scratch space —
 * indexing it wastes embedding quota on content nobody searches. Memory used
 * to ask the specialists module directly, which made a search feature depend
 * on a dispatch feature; now the owner declares its own groups and memory
 * stays ignorant of what a specialist is.
 */
type GroupExclusion = (groupId: string) => boolean;
const exclusions: GroupExclusion[] = [];

export function registerMemoryGroupExclusion(check: GroupExclusion): void {
  exclusions.push(check);
}

export function isMemoryGroupExcluded(groupId: string): boolean {
  for (const check of exclusions) {
    try {
      if (check(groupId)) return true;
    } catch (err) {
      log.error('Memory group exclusion check threw', { groupId, err });
    }
  }
  return false;
}

/**
 * A directory indexed alongside a group's own memory/: its Zettelkasten
 * folder, or one of its mounts marked `index`. A mount's files are stored
 * under `pathPrefix` — the path the container sees them at,
 * `extra/<mount>/…` — so a search hit maps straight to
 * /workspace/extra/<mount>/… and each file has one stable path, whatever the
 * host layout. (A path that changed between syncs would leave the old rows
 * until the next full sync removed them.) A folder inside the group's
 * workspace has no prefix: it is stored repo-relative, like memory/.
 */
/** In the repo, as the central DB's workspace-file tracking means it — not an indexed mount, not outside. */
function isRepoPath(p: string): boolean {
  return !p.startsWith('..') && !p.startsWith('extra/');
}

export interface IndexedDir {
  dir: string;
  source: string;
  pathPrefix?: string;
}

/**
 * The group's mounts marked for indexing, read from its container config in
 * the DB. (This replaces `memoryIndexDirs`, read from container.json — a file
 * regenerated from the DB at every spawn, which never carried the field, so
 * extra directories were never indexed.) Only mounts the allowlist accepts:
 * the indexer reads nothing the container could not.
 */
export async function indexedMountDirs(groupId: string): Promise<IndexedDir[]> {
  const row = await getContainerConfig(groupId);
  if (!row) return [];
  let mounts: AdditionalMountConfig[];
  try {
    mounts = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
  } catch {
    return [];
  }
  const dirs: IndexedDir[] = [];
  for (const mount of mounts) {
    if (!mount.index) continue;
    const check = validateMount(mount);
    if (!check.allowed) {
      log.warn('Indexed mount not indexed — rejected by the mount allowlist', {
        groupId,
        hostPath: mount.hostPath,
        reason: check.reason,
      });
      continue;
    }
    const name = check.resolvedContainerPath!;
    dirs.push({ dir: check.realHostPath!, source: name, pathPrefix: `extra/${name}` });
  }
  return dirs;
}
import { handleWorkspaceFileChanged, handleWorkspaceFileRemoved } from './rules.js';
import { workspaceIndexDirs } from './workspace-dirs.js';
import { CHUNKER_VERSION, chunkFile, type MemoryChunk } from './chunking.js';
import { createGeminiEmbeddingProvider, DEFAULT_GEMINI_EMBEDDING_MODEL, type EmbeddingProvider } from './embeddings.js';
import { GEMINI_EMBEDDING_DIMS, geminiProviderKey } from './embedding-identity.js';
import { isEmbeddingRateLimitError } from './embedding-errors.js';
import { TokenBucketRateLimiter, type RateLimiterSnapshot } from './rate-limiter.js';
import {
  openIndexDb,
  getCachedEmbedding,
  saveCachedEmbedding,
  deleteFileChunks,
  insertChunk,
  upsertFileRecord,
  getIndexFingerprint,
  setLastFullReindex,
  adoptUnkeyedCacheRows,
  getVectorState,
  repairVectors,
  setIndexFingerprint,
  searchIndex,
  type IndexDb,
  type FileSearchResult,
} from './index-db.js';

const ALLOWED_EXTENSIONS = new Set(['.md', '.org']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'venv', '__pycache__', '.venv']);
const WATCH_DEBOUNCE_MS = 3000;

/** How a pass ended: every file done, some left for the next sync, or stopped part-way. */
type SyncOutcome = 'completed' | 'incomplete' | 'interrupted';
const BATCH_SIZE = 100;

/** The rate limiter's estimate: a token per four characters. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split chunks to embed into batches the rate limiter can grant: at most
 * BATCH_SIZE chunks, and at most the per-minute token limit. Batches were cut
 * by count alone, so a file with many uncached chunks (~37+ at 400 tokens)
 * asked for more tokens than the bucket can ever hold and the sync waited
 * forever — the first large org file stalled the whole index.
 */
export function batchEmbeddings<T>(
  items: T[],
  tokensOf: (item: T) => number,
  maxCount = BATCH_SIZE,
  maxTokens = MEMORY_CONFIG.embedding_tpm_limit,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const t = tokensOf(item);
    if (current.length > 0 && (current.length >= maxCount || tokens + t > maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += t;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
// Chunk candidates per requested file: grouping by file uses some up.
const CANDIDATES_MULTIPLIER = 8;
const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

export type MemorySearchResult = FileSearchResult & {
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
  /** Set until a full re-index under the current settings has completed. */
  private forcePending = false;
  /** Why the pending full re-index runs: the settings that changed. */
  private reindexReason: string | null = null;
  /** The full re-index under way, for stats. */
  private reindex: { reason: string; startedAt: string; done: number; total: number } | null = null;
  private providerKey = '';
  private syncLock: Promise<void> = Promise.resolve();
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private rpdResumeTimer: ReturnType<typeof setTimeout> | null = null;
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
    private readonly additionalDirs: IndexedDir[] = [],
  ) {}

  async init(): Promise<void> {
    fsSync.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.providerKey = geminiProviderKey(this.model);
    this.index = await openIndexDb(this.dbPath, this.model, GEMINI_EMBEDDING_DIMS);
    adoptUnkeyedCacheRows(this.index.db, 'gemini', geminiProviderKey);

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

    const dirsToWatch = [this.memoryDir, ...this.additionalDirs.map((d) => d.dir)];
    for (const watchDir of dirsToWatch) {
      try {
        const sub = await parcelWatcher.subscribe(watchDir, (err: Error | null, events: parcelWatcher.Event[]) => {
          if (err) return;
          const relevant = events.some((e) => !e.path.split(path.sep).some((part: string) => IGNORED_DIRS.has(part)));
          if (relevant) markDirty();
        });
        this.watchers.push(sub);
      } catch (err) {
        log.warn('Memory watcher failed to start', { groupId: this.groupId, dir: watchDir, err });
      }
    }

    // Periodic sync every 24h in case watcher misses events
    this.periodicTimer = setInterval(
      () => {
        this.dirty = true;
        void this.sync();
      },
      24 * 60 * 60 * 1000,
    );

    // A full re-index only when the settings that shape the index changed
    // since it was last fully built; otherwise only changed files are
    // re-indexed. Re-indexing everything on every start rewrote the whole
    // index.db (~1.6 GB of backup delta per host restart) for no change.
    const stored = getIndexFingerprint(this.index.db);
    this.forcePending = stored !== this.fingerprint();
    if (this.forcePending) {
      this.reindexReason = this.fingerprintChanges(stored);
      log.warn('Memory index: settings changed since the last full build; re-indexing every file', {
        groupId: this.groupId,
        changes: this.reindexReason,
      });
    }
    this.dirty = true;
    void this.sync();

    log.info('Memory index manager initialized', {
      groupId: this.groupId,
      groupFolder: this.groupFolder,
      memoryDir: this.memoryDir,
      additionalDirs: this.additionalDirs.map((d) => d.source),
    });
  }

  // Pick the interrupted sync back up once the daily quota stop lifts, rather
  // than waiting for a file change or the 24h periodic pass.
  private scheduleRpdResume(delayMs: number): void {
    if (this.closed) return;
    if (this.rpdResumeTimer) clearTimeout(this.rpdResumeTimer);
    this.rpdResumeTimer = setTimeout(() => {
      this.rpdResumeTimer = null;
      this.dirty = true;
      void this.sync();
    }, delayMs + 1000);
    this.rpdResumeTimer.unref?.();
  }

  /**
   * What an unchanged file's index entries depend on besides its content.
   * Recorded once a full re-index under it completes; a mismatch at start
   * forces one, so no file keeps chunks from an older model or chunker.
   */
  private fingerprint(): string {
    return JSON.stringify(this.fingerprintFields());
  }

  private fingerprintFields(): Record<string, string | number> {
    return {
      model: this.model,
      chunkTokens: MEMORY_CONFIG.chunk_tokens,
      chunkOverlap: MEMORY_CONFIG.chunk_overlap_tokens,
      chunker: CHUNKER_VERSION,
      provider: 'gemini',
      providerKey: this.providerKey,
      vectorDims: GEMINI_EMBEDDING_DIMS,
    };
  }

  /** "field: old → new" for each setting that differs from the stored fingerprint. */
  private fingerprintChanges(stored: string | null): string {
    if (stored === null) return 'first full build (no settings recorded)';
    let old: Record<string, unknown> = {};
    try {
      old = JSON.parse(stored) as Record<string, unknown>;
    } catch {}
    const current = this.fingerprintFields();
    const keys = [...new Set([...Object.keys(old), ...Object.keys(current)])];
    return keys
      .filter((k) => JSON.stringify(old[k]) !== JSON.stringify(current[k]))
      .map(
        (k) =>
          `${k}: ${old[k] === undefined ? '(none)' : String(old[k])} → ${current[k] === undefined ? '(none)' : String(current[k])}`,
      )
      .join('; ');
  }

  private repairVectors(): void {
    try {
      const repair = repairVectors(this.index);
      if (!repair) return;
      const level = repair.failed > 0 ? 'warn' : 'info';
      log[level]('Memory index: vector rows repaired', { groupId: this.groupId, ...repair });
    } catch (err) {
      log.warn('Memory index: vector repair failed', { groupId: this.groupId, err });
    }
  }

  async sync(opts?: { force?: boolean }): Promise<void> {
    this.syncLock = this.syncLock.then(() => this._doSync((opts?.force ?? false) || this.forcePending)).catch(() => {});
    return this.syncLock;
  }

  private async _doSync(force: boolean): Promise<void> {
    if (!force && !this.dirty) return;
    if (!force) {
      await this.syncFiles(false);
      return;
    }

    // A full re-index: logged, recorded in meta, and its progress reported
    // (stats) while it runs.
    const reason = this.reindexReason ?? 'requested';
    const startedAt = new Date().toISOString();
    this.reindex = { reason, startedAt, done: 0, total: 0 };
    log.info('Memory index: full re-index started', { groupId: this.groupId, reason });
    try {
      setLastFullReindex(this.index.db, { reason, startedAt, finishedAt: null, files: 0, result: 'running' });
    } catch {}
    let outcome: SyncOutcome = 'interrupted';
    try {
      outcome = await this.syncFiles(true);
    } finally {
      const files = this.reindex?.done ?? 0;
      this.reindex = null;
      const finishedAt = new Date().toISOString();
      try {
        if (!this.closed) setLastFullReindex(this.index.db, { reason, startedAt, finishedAt, files, result: outcome });
      } catch {}
      if (outcome === 'completed') this.reindexReason = null;
      log[outcome === 'completed' ? 'info' : 'warn']('Memory index: full re-index finished', {
        groupId: this.groupId,
        reason,
        files,
        result: outcome,
      });
    }
  }

  /** One pass over every indexed file; force re-indexes unchanged files too. */
  private async syncFiles(force: boolean): Promise<SyncOutcome> {
    this.dirty = false;
    this._syncing = true;

    const allSources: Array<{ dir: string; source: string; pathPrefix?: string }> = [
      { dir: this.memoryDir, source: 'memory' },
      ...this.additionalDirs,
    ];

    // Collect all files across all source dirs
    const fileEntries: Array<{ absPath: string; source: string; dir: string; pathPrefix?: string }> = [];
    for (const { dir, source, pathPrefix } of allSources) {
      const files = await listMemoryFiles(dir);
      for (const absPath of files) fileEntries.push({ absPath, source, dir, pathPrefix });
    }

    log.info('Memory sync: starting', { groupId: this.groupId, count: fileEntries.length, force });
    if (this.reindex) this.reindex.total = fileEntries.length;

    let indexed = 0,
      skipped = 0,
      removed = 0;
    let incomplete = 0;
    let consecutiveRlFailures = 0;
    const MAX_CONSECUTIVE_RL = 3;
    const seenPaths = new Set<string>();

    for (const { absPath, source: fileSource, dir, pathPrefix } of fileEntries) {
      if (this.closed) break;
      if (this.reindex) this.reindex.done++;

      let content: string;
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absPath);
        content = await fs.readFile(absPath, 'utf-8');
      } catch {
        continue;
      }

      // The group's own memory: repo-relative. An indexed mount: the path the
      // container sees it at (see IndexedDir).
      const repoPath = pathPrefix
        ? `${pathPrefix}/${path.relative(dir, absPath).split(path.sep).join('/')}`
        : path.relative(path.resolve('.'), absPath).replace(/\\/g, '/');
      seenPaths.add(repoPath);

      const contentHash = hashFile(content);

      // Update central DB (spec compliance) — only for in-repo paths
      if (isRepoPath(repoPath)) {
        handleWorkspaceFileChanged({ group_id: this.groupId, path: repoPath, content_hash: contentHash });
      }

      // Check if already indexed with same hash
      // The source too: a folder relabelled keeps its paths and content.
      const existing = this.index.db.prepare('SELECT hash, source FROM files WHERE path = ?').get(repoPath) as
        | { hash: string; source: string }
        | undefined;
      if (existing?.hash === contentHash && existing.source === fileSource && !force) {
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
        const cached = getCachedEmbedding(this.index.db, this.model, this.providerKey, chunk.hash);
        if (cached) {
          embeddings[ci] = cached;
        } else {
          toEmbed.push({ chunk, idx: ci });
        }
      }

      const toEmbedFiltered = toEmbed.filter((e) => e.chunk.text.trim().length > 0);

      // A file is written only when every chunk has its embedding: one written
      // with chunks missing would be recorded as indexed and never retried.
      let complete = true;
      if (toEmbedFiltered.length > 0) {
        for (const batch of batchEmbeddings(toEmbedFiltered, (e) => estimateTokens(e.chunk.text))) {
          if (this.closed) {
            complete = false;
            break;
          }
          const texts = batch.map((e) => e.chunk.text);
          const estimatedTokens = texts.reduce((s, t) => s + estimateTokens(t), 0);
          try {
            await this.rateLimiter.acquirePermit(1, 600_000, estimatedTokens);
            const vecs = await this.provider.embedBatch(texts);
            for (let j = 0; j < batch.length; j++) {
              const item = batch[j];
              const vec = vecs[j];
              if (!item || !vec) continue;
              embeddings[item.idx] = vec;
              saveCachedEmbedding(this.index.db, this.model, this.providerKey, item.chunk.hash, vec);
            }
            consecutiveRlFailures = 0;
          } catch (err) {
            if (isEmbeddingRateLimitError(err) && err.quotaType === 'rpd') {
              this.rateLimiter.depleteQuotaForType('rpd');
              const resumeInMs = this.rateLimiter.rpdResumeInMs();
              log.warn('Memory sync: RPD exhausted, resuming in 24h', {
                groupId: this.groupId,
                resumeAt: new Date(Date.now() + resumeInMs).toISOString(),
              });
              this.dirty = true;
              this._syncing = false;
              this.scheduleRpdResume(resumeInMs);
              return 'interrupted';
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
                return 'interrupted';
              }
            }
            log.warn('Memory sync: embedding batch failed, skipping file', {
              groupId: this.groupId,
              err,
              file: absPath,
            });
            complete = false;
            break;
          }
        }
      }
      if (!complete) {
        // Unrecorded, so the next sync takes it up again.
        this.dirty = true;
        incomplete++;
        continue;
      }

      // One transaction per file: its chunk, keyword and vector rows and its
      // files row change together, so a reader (the container mounts this
      // file read-only) sees the file before or after, never half-written, and
      // a failure part-way leaves the old entries whole.
      try {
        this.index.db.transaction(() => {
          deleteFileChunks(this.index.db, repoPath, this.index.vecAvailable);

          for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];
            const vec = embeddings[ci];
            if (!chunk || !vec) continue;
            const chunkId = `${repoPath}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`;
            insertChunk(this.index.db, {
              id: chunkId,
              path: repoPath,
              source: fileSource,
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
            source: fileSource,
            hash: contentHash,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          });
        })();
      } catch (err) {
        if (this.closed) break;
        log.warn('Memory sync: writing file failed, kept its previous entries', {
          groupId: this.groupId,
          file: repoPath,
          err,
        });
        this.dirty = true;
        incomplete++;
        continue;
      }
      indexed++;
    }

    // Stopped part-way: seenPaths covers only the files reached, so the
    // stale pass below would drop every file not yet visited.
    if (this.closed) {
      this._syncing = false;
      return 'interrupted';
    }

    // Remove stale files no longer on disk
    const allPaths = (this.index.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map(
      (r) => r.path,
    );
    for (const p of allPaths) {
      if (!seenPaths.has(p)) {
        try {
          this.index.db.transaction(() => {
            deleteFileChunks(this.index.db, p, this.index.vecAvailable);
            this.index.db.prepare('DELETE FROM files WHERE path = ?').run(p);
          })();
        } catch (err) {
          log.warn('Memory sync: removing a deleted file failed', { groupId: this.groupId, file: p, err });
          this.dirty = true;
          continue;
        }
        if (isRepoPath(p)) handleWorkspaceFileRemoved({ group_id: this.groupId, path: p });
        removed++;
      }
    }

    // Vector rows that drifted from the chunks — a failed or impossible vector
    // write, or an index never checked — are put right from the stored
    // embeddings, no embedding calls.
    if (getVectorState(this.index.db) !== 'clean') this.repairVectors();

    // A file left incomplete still holds its old entries under an unchanged
    // hash, so only a forced pass that reached every file clears the debt.
    if (force && incomplete === 0) {
      setIndexFingerprint(this.index.db, this.fingerprint());
      this.forcePending = false;
    }

    this._syncing = false;
    this._lastSyncAt = Date.now();
    log.info('Memory sync complete', { groupId: this.groupId, indexed, skipped, removed });
    return incomplete === 0 ? 'completed' : 'incomplete';
  }

  /**
   * Full hybrid search (vector + FTS5). Called by host-side memory_hybrid_search.
   * Keyword-only when the query cannot be embedded — including when no
   * embedding permit is granted within `embedWaitMs`: a search does not queue
   * behind indexing for the rate limiter's cool-down or the daily stop.
   */
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      pathPrefix?: string;
      source?: string;
      includeContent?: boolean;
      embedWaitMs?: number;
    },
  ): Promise<{ mode: 'hybrid' | 'keyword'; results: MemorySearchResult[] }> {
    if (!query.trim() || this.closed) return { mode: 'keyword', results: [] };

    // Trigger background sync if dirty; search on current state immediately.
    if (this.dirty) void this.sync();

    let queryVec: number[] = [];
    try {
      await this.searchPermit(opts?.embedWaitMs ?? MEMORY_CONFIG.search_embed_wait_ms);
      queryVec = await this.provider.embedQuery(query);
    } catch (err) {
      log.warn('Memory search: query embed failed, falling back to FTS', { groupId: this.groupId, err });
    }
    const mode = queryVec.length > 0 ? 'hybrid' : 'keyword';

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
      locationsPerFile: MEMORY_CONFIG.search_locations_per_file,
    });

    if (!includeContent) return { mode, results };

    const withContent = await Promise.all(
      results.map(async (r) => {
        const result: MemorySearchResult = { ...r };
        try {
          const absPath = path.resolve(process.cwd(), r.path);
          const content = await fs.readFile(absPath, 'utf-8');
          result.content = content;
          result.frontmatter = parseFrontmatterYaml(content);
        } catch {}
        return result;
      }),
    );
    return { mode, results: withContent };
  }

  /**
   * An embedding permit, or a rejection once `waitMs` has passed. A permit
   * granted after the deadline is still spent from the budget — one request,
   * the price of not cancelling inside the limiter.
   */
  private async searchPermit(waitMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no embedding permit within ${waitMs}ms`)), waitMs);
    });
    const permit = this.rateLimiter.acquirePermit(1, waitMs);
    // Once the deadline wins nobody awaits the permit; a later rejection
    // must not surface as an unhandled one.
    permit.catch(() => {});
    try {
      await Promise.race([permit, deadline]);
    } finally {
      clearTimeout(timer);
    }
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

  /** Index health for the dashboard: files and chunks per source, sync state, embedding quota. */
  stats(): MemoryIndexStats | null {
    if (this.closed || !this.index) return null;
    const files = this.index.db.prepare('SELECT source, COUNT(*) AS n FROM files GROUP BY source').all() as Array<{
      source: string;
      n: number;
    }>;
    const chunks = new Map(
      (
        this.index.db.prepare('SELECT source, COUNT(*) AS n FROM chunks GROUP BY source').all() as Array<{
          source: string;
          n: number;
        }>
      ).map((r) => [r.source, r.n]),
    );
    const sources = files
      .map((f) => ({ source: f.source, files: f.n, chunks: chunks.get(f.source) ?? 0 }))
      .sort((a, b) => a.source.localeCompare(b.source));
    return {
      groupId: this.groupId,
      groupFolder: this.groupFolder,
      model: this.model,
      vectorSearch: this.index.vecAvailable,
      syncing: this._syncing,
      dirty: this.dirty,
      lastSyncAt: this._lastSyncAt === null ? null : new Date(this._lastSyncAt).toISOString(),
      sources,
      quota: this.rateLimiter.snapshot(),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    if (this.rpdResumeTimer) clearTimeout(this.rpdResumeTimer);
    // Bounded: while the native watcher is still crawling a large tree (the
    // first minutes after start), unsubscribe does not return, and the host
    // shutdown it sits in was killed before it finished (2026-10-12).
    await settleWithin(Promise.allSettled(this.watchers.map((sub) => sub.unsubscribe())), CLOSE_WAIT_MS);
    // Let an in-flight sync reach its next `closed` check before the index
    // goes away under it.
    await settleWithin(this.syncLock, CLOSE_WAIT_MS);
    try {
      this.index.db.close();
    } catch {}
  }
}

/** How long close() waits on each of the watchers and an in-flight sync. */
const CLOSE_WAIT_MS = 1000;

function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export interface MemoryIndexStats {
  groupId: string;
  groupFolder: string;
  model: string;
  vectorSearch: boolean;
  syncing: boolean;
  dirty: boolean;
  lastSyncAt: string | null;
  sources: Array<{ source: string; files: number; chunks: number }>;
  quota: RateLimiterSnapshot;
}

// Module-level manager registry — one instance per group
const managers = new Map<string, MemoryIndexManager>();

/** Index health of every open manager, for the dashboard. */
export function getAllMemoryIndexStats(): MemoryIndexStats[] {
  const out: MemoryIndexStats[] = [];
  for (const m of managers.values()) {
    try {
      const s = m.stats();
      if (s) out.push(s);
    } catch (err) {
      log.debug('Memory index stats unavailable', { err });
    }
  }
  return out;
}

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
  additionalDirs?: IndexedDir[];
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
    params.additionalDirs ?? [],
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
  allowedFolders?: Set<string>;
}): Promise<void> {
  if (!params.apiKey) {
    log.warn('Memory search disabled: MEMORY_SEARCH_GEMINI_API_KEY not set');
    return;
  }

  for (const group of params.groups) {
    if (isMemoryGroupExcluded(group.id)) continue;
    if (params.allowedFolders && !params.allowedFolders.has(group.folder)) continue;
    const memoryDir = path.join(params.groupsDir, group.folder, 'memory');
    const dbDir = path.join(params.dataDir, 'v2-memory', group.id);
    const dbPath = path.join(dbDir, 'index.db');

    const additionalDirs = [
      ...workspaceIndexDirs(path.join(params.groupsDir, group.folder)),
      ...(await indexedMountDirs(group.id)),
    ];

    await ensureMemoryManager({
      groupId: group.id,
      groupFolder: group.folder,
      memoryDir,
      dbPath,
      apiKey: params.apiKey,
      model: params.model,
      additionalDirs,
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
  allowedFolders?: Set<string>;
}): Promise<void> {
  if (!params.apiKey) return;
  if (isMemoryGroupExcluded(params.group.id)) return;
  if (params.allowedFolders && !params.allowedFolders.has(params.group.folder)) return;

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
    additionalDirs: workspaceIndexDirs(path.join(params.groupsDir, group.folder)),
  }).catch((err) => {
    log.warn('Failed to init memory manager for group', { groupId: group.id, err });
  });
}
