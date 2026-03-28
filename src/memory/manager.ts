import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import chokidar, { type FSWatcher } from 'chokidar';

import {
  GROUPS_DIR,
  STORE_DIR,
  MEMORY_SEARCH_ENABLED,
  MEMORY_SEARCH_EXTRA_PATHS,
  MEMORY_SEARCH_GEMINI_API_KEY,
  MEMORY_SEARCH_MAX_RESULTS,
  MEMORY_SEARCH_MIN_SCORE,
  MEMORY_SEARCH_MODEL,
  MEMORY_SEARCH_RPD_SESSION_BUDGET,
  MEMORY_SEARCH_RPM_LIMIT,
} from '../config.js';
import { logger } from '../logger.js';
import {
  createGeminiEmbeddingProvider,
  type EmbeddingProvider,
} from './embeddings-gemini.js';
import { isEmbeddingRateLimitError } from './embedding-errors.js';
import {
  buildFileEntry,
  chunkMarkdown,
  hashText,
  listMemoryFiles,
  type MemoryChunk,
} from './internal.js';
import { chunkOrgMode } from './org-chunking.js';
import { ensureMemoryIndexSchema } from './schema.js';
import { loadSqliteVecExtension } from './sqlite-vec.js';
import { mergeHybridResults } from './hybrid.js';
import { searchVector, searchKeyword } from './search.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

/** Strip /workspace/group/ prefix from agent-provided paths to get workspace-relative path. */
function normaliseInputPath(p: string, _workspaceDir: string): string {
  const containerPrefix = '/workspace/group/';
  return p.startsWith(containerPrefix) ? p.slice(containerPrefix.length) : p;
}

/** Parse YAML front matter from a markdown/org file. Returns undefined if none found. */
export function parseFrontmatterYaml(
  content: string,
): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match || !match[1]) return undefined;
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    // Parse arrays like [a, b, c]
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

const VECTOR_TABLE = 'chunks_vec';
const FTS_TABLE = 'chunks_fts';
const CACHE_TABLE = 'embedding_cache';
const META_KEY = 'memory_index_meta_v1';

const CHUNKING = { tokens: 400, overlap: 80 };
const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;
const CANDIDATES_MULTIPLIER = 4;
const WATCH_DEBOUNCE_MS = 3000;

type MemoryMeta = {
  model: string;
  provider: string;
  vectorDims: number;
  chunkTokens: number;
  chunkOverlap: number;
};

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  content?: string;
  frontmatter?: Record<string, unknown>;
};

export type MemoryFileEntry = {
  path: string;
  mtime: number;
  size: number;
  indexed: boolean;
  frontmatter?: Record<string, unknown>;
};

export class MemoryIndexManager {
  private db!: Database.Database;
  private provider!: EmbeddingProvider;
  private rateLimiter!: TokenBucketRateLimiter;
  private watcher: FSWatcher | null = null;
  private dirty = true;
  private syncLock: Promise<void> = Promise.resolve();
  private vecAvailable = false;
  private closed = false;
  private periodicSyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly workspaceDir: string,
    private readonly dbPath: string,
    private readonly extraPaths: string[],
    private readonly apiKey: string,
    private readonly model: string,
    private readonly rpmLimit: number,
    private readonly rpdSessionBudget: number,
    private readonly maxResults: number,
    private readonly minScore: number,
  ) {}

  async init(): Promise<void> {
    // Open DB with WAL mode for crash safety
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    // Load sqlite-vec extension for vector search
    const vecResult = await loadSqliteVecExtension({ db: this.db });
    if (vecResult.ok) {
      this.vecAvailable = true;
      const version = this.db.prepare('SELECT vec_version() AS v').get() as {
        v: string;
      };
      logger.info(
        { version: version.v, dbPath: this.dbPath },
        'sqlite-vec loaded',
      );

      // Create the vector virtual table (needs to know dims from meta or default 3072)
      const existingMeta = this.readMeta();
      const dims = existingMeta?.vectorDims ?? 3072;
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
          `  id TEXT PRIMARY KEY,\n` +
          `  embedding float[${dims}]\n` +
          `);`,
      );
    } else {
      logger.warn(
        { error: vecResult.error },
        'sqlite-vec failed to load, using FTS fallback',
      );
    }

    ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: CACHE_TABLE,
      ftsTable: FTS_TABLE,
    });

    // Write meta on first init
    if (!this.readMeta()) {
      this.writeMeta({
        model: this.model,
        provider: 'gemini',
        vectorDims: 3072,
        chunkTokens: CHUNKING.tokens,
        chunkOverlap: CHUNKING.overlap,
      });
    }

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: this.apiKey,
      model: this.model,
    });
    this.provider = provider;

    this.rateLimiter = new TokenBucketRateLimiter({
      accountKey: hashText(this.apiKey).slice(0, 16),
      rpmLimit: this.rpmLimit,
      rpdSessionBudget: this.rpdSessionBudget,
    });

    // Watch for file changes
    const watchPaths = [this.workspaceDir, ...this.extraPaths];
    this.watcher = chokidar.watch(watchPaths, {
      ignored: /(^|[/\\])(\.git|node_modules|venv|__pycache__)/,
      persistent: false,
      ignoreInitial: true,
      usePolling: false,
    });

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const markDirty = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.dirty = true;
      }, WATCH_DEBOUNCE_MS);
    };
    this.watcher
      .on('add', markDirty)
      .on('change', markDirty)
      .on('unlink', markDirty);

    logger.info(
      { workspaceDir: this.workspaceDir, extraPaths: this.extraPaths },
      'Memory index manager initialized',
    );
  }

  private readMeta(): MemoryMeta | null {
    try {
      const row = this.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(META_KEY) as { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as MemoryMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: MemoryMeta): void {
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(META_KEY, JSON.stringify(meta));
  }

  /** Synchronize the index: embed new/changed files, remove deleted ones. */
  async sync(opts?: { force?: boolean }): Promise<void> {
    // Serialize syncs to avoid parallel embedding calls
    this.syncLock = this.syncLock
      .then(() => this._doSync(opts?.force ?? false))
      .catch(() => {});
    return this.syncLock;
  }

  private async _doSync(force: boolean): Promise<void> {
    if (!force && !this.dirty) return;
    this.dirty = false;

    const files = await listMemoryFiles(this.workspaceDir, this.extraPaths);
    logger.debug({ count: files.length }, 'Memory sync: discovered files');

    let indexed = 0;
    let skipped = 0;
    let removed = 0;
    let consecutiveRateLimitFailures = 0;
    const MAX_CONSECUTIVE_RL_FAILURES = 3;

    // Track paths we encounter
    const seenPaths = new Set<string>();

    for (let i = 0; i < files.length; i++) {
      if (this.closed) break;
      const absPath = files[i];
      if (!absPath) continue;

      const entry = await buildFileEntry(absPath, this.workspaceDir);
      if (!entry) continue;

      seenPaths.add(entry.path);

      // Check if file is already indexed with same hash
      const existing = this.db
        .prepare('SELECT hash FROM files WHERE path = ?')
        .get(entry.path) as { hash: string } | undefined;

      if (existing?.hash === entry.hash && !force) {
        skipped++;
        continue;
      }

      // Chunk the file
      let chunks: MemoryChunk[];
      try {
        const content = await fs.readFile(absPath, 'utf-8');
        if (absPath.endsWith('.org')) {
          chunks = chunkOrgMode(content, CHUNKING);
        } else {
          chunks = chunkMarkdown(content, CHUNKING);
        }
      } catch {
        continue;
      }

      if (chunks.length === 0) continue;

      // Embed chunks (check cache first)
      const toEmbed: Array<{ chunk: MemoryChunk; idx: number }> = [];
      const embeddings: (number[] | null)[] = new Array(chunks.length).fill(
        null,
      );

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        if (!chunk) continue;
        const cached = this.db
          .prepare(
            'SELECT embedding FROM embedding_cache WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?',
          )
          .get('gemini', this.model, '', chunk.hash) as
          | { embedding: string }
          | undefined;
        if (cached) {
          try {
            embeddings[ci] = JSON.parse(cached.embedding) as number[];
          } catch {}
        } else {
          toEmbed.push({ chunk, idx: ci });
        }
      }

      // Filter out empty-text chunks before sending to Gemini (400 "empty Part" error)
      const toEmbedFiltered = toEmbed.filter(
        (e) => e.chunk.text.trim().length > 0,
      );

      if (toEmbedFiltered.length > 0) {
        // Embed in batches of 100
        const BATCH_SIZE = 100;
        for (let b = 0; b < toEmbedFiltered.length; b += BATCH_SIZE) {
          if (this.closed) break;
          const batch = toEmbedFiltered.slice(b, b + BATCH_SIZE);
          const texts = batch.map((e) => e.chunk.text);
          try {
            await this.rateLimiter.acquirePermit(1);
            const vecs = await this.provider.embedBatch(texts);
            for (let j = 0; j < batch.length; j++) {
              const item = batch[j];
              const vec = vecs[j];
              if (!item || !vec) continue;
              embeddings[item.idx] = vec;
              // Cache the embedding
              this.db
                .prepare(
                  'INSERT OR REPLACE INTO embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .run(
                  'gemini',
                  this.model,
                  '',
                  item.chunk.hash,
                  JSON.stringify(vec),
                  vec.length,
                  Date.now(),
                );
            }
            consecutiveRateLimitFailures = 0; // successful batch resets the counter
          } catch (err) {
            if (isEmbeddingRateLimitError(err) && err.quotaType === 'rpd') {
              logger.warn(
                { file: absPath },
                'Memory sync: RPD session budget exhausted, stopping',
              );
              this.dirty = true; // retry next session
              return;
            }
            if (isEmbeddingRateLimitError(err)) {
              // RPM/TPM 429: apply cool-down so next acquirePermit waits appropriately
              this.rateLimiter.depleteQuotaForType(
                err.quotaType,
                err.retryDelayMs,
              );
              consecutiveRateLimitFailures++;
              if (consecutiveRateLimitFailures >= MAX_CONSECUTIVE_RL_FAILURES) {
                logger.warn(
                  { consecutiveRateLimitFailures, file: absPath },
                  'Memory sync: too many consecutive 429s, stopping for this session',
                );
                this.dirty = true; // retry next startup
                return;
              }
            }
            logger.warn(
              { err, file: absPath },
              'Memory sync: embedding batch failed, skipping file',
            );
            break;
          }
        }
      }

      // Delete old chunks for this file
      this.deleteFileChunks(entry.path);

      // Insert new chunks
      const now = Date.now();
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const vec = embeddings[ci];
        if (!chunk || !vec) continue;

        const chunkId = `${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}`;
        const embeddingJson = JSON.stringify(vec);

        this.db
          .prepare(
            'INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            chunkId,
            entry.path,
            'memory',
            chunk.startLine,
            chunk.endLine,
            chunk.hash,
            this.model,
            chunk.text,
            embeddingJson,
            now,
          );

        if (this.vecAvailable) {
          try {
            this.db
              .prepare(
                `INSERT OR REPLACE INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`,
              )
              .run(chunkId, Buffer.from(new Float32Array(vec).buffer));
          } catch (err) {
            logger.debug({ err }, 'chunks_vec insert failed');
          }
        }

        this.db
          .prepare(
            `INSERT OR REPLACE INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            chunk.text,
            chunkId,
            entry.path,
            'memory',
            this.model,
            chunk.startLine,
            chunk.endLine,
          );
      }

      // Upsert file record
      this.db
        .prepare(
          'INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          entry.path,
          'memory',
          entry.hash,
          Math.round(entry.mtimeMs),
          entry.size,
        );

      indexed++;
      if (i % 50 === 0 && i > 0) {
        logger.info({ indexed, total: files.length }, 'Memory sync: progress');
      }
    }

    // Remove chunks for files no longer present
    const allPaths = (
      this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>
    ).map((r) => r.path);
    for (const p of allPaths) {
      if (!seenPaths.has(p)) {
        this.deleteFileChunks(p);
        this.db.prepare('DELETE FROM files WHERE path = ?').run(p);
        removed++;
      }
    }

    logger.info({ indexed, skipped, removed }, 'Memory sync complete');
  }

  private deleteFileChunks(filePath: string): void {
    const chunkIds = (
      this.db
        .prepare('SELECT id FROM chunks WHERE path = ?')
        .all(filePath) as Array<{ id: string }>
    ).map((r) => r.id);

    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
    this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ?`).run(filePath);

    if (this.vecAvailable && chunkIds.length > 0) {
      for (const id of chunkIds) {
        try {
          this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(id);
        } catch {}
      }
    }
  }

  /** Total number of indexed chunks. */
  totalIndexed(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as {
      n: number;
    };
    return row.n;
  }

  /** Search the index for chunks relevant to the query. */
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
    if (!query.trim()) return [];
    if (this.closed) return [];

    const maxResults = opts?.maxResults ?? this.maxResults;
    const minScore = opts?.minScore ?? this.minScore;
    const pathPrefix = opts?.pathPrefix;
    const source = opts?.source;
    const includeContent = opts?.includeContent ?? false;

    // Trigger background sync if dirty; search on current DB state immediately.
    // Sync is non-destructive for unchanged files (only updates changed ones),
    // so there is no need to wait for it to complete before querying.
    if (this.dirty) {
      void this.sync();
    }

    let queryVec: number[] = [];
    try {
      queryVec = await this.provider.embedQuery(query);
    } catch (err) {
      logger.warn(
        { err },
        'Memory search: failed to embed query, falling back to FTS',
      );
    }

    const candidates = maxResults * CANDIDATES_MULTIPLIER;

    const vectorResults =
      queryVec.length > 0
        ? searchVector({
            db: this.db,
            vectorTable: VECTOR_TABLE,
            providerModel: this.model,
            queryVec,
            limit: candidates,
            vecAvailable: this.vecAvailable,
          })
        : [];

    const keywordResults = searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel: this.model,
      query,
      limit: candidates,
    });

    const merged = mergeHybridResults({
      vector: vectorResults.map((r) => ({ ...r, vectorScore: r.score })),
      keyword: keywordResults.map((r) => ({ ...r, textScore: r.score })),
      vectorWeight: VECTOR_WEIGHT,
      textWeight: TEXT_WEIGHT,
    });

    const limited = Math.min(maxResults, includeContent ? 10 : maxResults);
    const filtered = merged
      .filter((r) => r.score >= minScore)
      .filter((r) => !pathPrefix || r.path.startsWith(pathPrefix))
      .filter((r) => !source || r.source === source)
      .slice(0, limited);

    const results: MemorySearchResult[] = await Promise.all(
      filtered.map(async (r) => {
        const result: MemorySearchResult = {
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          score: r.score,
          snippet: r.snippet,
        };
        if (includeContent) {
          try {
            const fileData = await this.getFileContent(r.path, {
              parseFrontmatter: true,
            });
            result.content = fileData.content;
            result.frontmatter = fileData.frontmatter;
          } catch {}
        }
        return result;
      }),
    );

    return results;
  }

  /** Read full content of a file in the index. */
  async getFileContent(
    relPath: string,
    opts?: { parseFrontmatter?: boolean },
  ): Promise<{
    path: string;
    content: string;
    size: number;
    frontmatter?: Record<string, unknown>;
    indexed: boolean;
    lastIndexed?: number;
  }> {
    const normalised = normaliseInputPath(relPath, this.workspaceDir);
    const parseFrontmatter = opts?.parseFrontmatter ?? true;

    // Resolve the file: try workspace-relative first, then extra paths
    const candidates = [
      path.resolve(this.workspaceDir, normalised),
      ...this.extraPaths.map((ep) => path.resolve(ep, normalised)),
    ];

    let absPath: string | null = null;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        absPath = candidate;
        break;
      } catch {}
    }

    if (!absPath) {
      throw new Error(`File not found: ${normalised}`);
    }

    const content = await fs.readFile(absPath, 'utf-8');
    const stat = await fs.stat(absPath);

    const fileRow = this.db
      .prepare('SELECT mtime FROM files WHERE path = ?')
      .get(normalised) as { mtime: number } | undefined;

    const result: {
      path: string;
      content: string;
      size: number;
      frontmatter?: Record<string, unknown>;
      indexed: boolean;
      lastIndexed?: number;
    } = {
      path: normalised,
      content,
      size: stat.size,
      indexed: !!fileRow,
      lastIndexed: fileRow?.mtime,
    };

    if (parseFrontmatter) {
      result.frontmatter = parseFrontmatterYaml(content);
    }

    return result;
  }

  /** List indexed files matching filters. */
  listFiles(opts?: {
    pathPrefix?: string;
    source?: string;
    limit?: number;
    orderBy?: 'mtime' | 'path' | 'size';
    parseFrontmatter?: boolean;
  }): { files: MemoryFileEntry[]; total: number } {
    const limit = Math.min(
      opts?.limit ?? 50,
      opts?.parseFrontmatter ? 50 : 200,
    );
    const orderBy = opts?.orderBy ?? 'mtime';
    const orderCol =
      orderBy === 'mtime' ? 'mtime' : orderBy === 'size' ? 'size' : 'path';
    const orderDir = orderBy === 'path' ? 'ASC' : 'DESC';

    let query = 'SELECT path, mtime, size FROM files';
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (opts?.pathPrefix) {
      conditions.push('path LIKE ?');
      params.push(`${opts.pathPrefix}%`);
    }
    if (opts?.source) {
      conditions.push('source = ?');
      params.push(opts.source);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const total = (
      this.db
        .prepare(
          query.replace('SELECT path, mtime, size', 'SELECT COUNT(*) AS n'),
        )
        .get(...params) as { n: number }
    ).n;

    query += ` ORDER BY ${orderCol} ${orderDir} LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as Array<{
      path: string;
      mtime: number;
      size: number;
    }>;

    const files: MemoryFileEntry[] = rows.map((row) => {
      const entry: MemoryFileEntry = {
        path: row.path,
        mtime: row.mtime,
        size: row.size,
        indexed: true,
      };
      if (opts?.parseFrontmatter) {
        try {
          const absPath = path.resolve(this.workspaceDir, row.path);
          const content = readFileSync(absPath, 'utf-8');
          entry.frontmatter = parseFrontmatterYaml(content);
        } catch {}
      }
      return entry;
    });

    return { files, total };
  }

  startPeriodicSync(intervalMs: number): void {
    if (this.periodicSyncTimer) clearInterval(this.periodicSyncTimer);
    this.periodicSyncTimer = setInterval(() => {
      if (!this.closed) {
        this.dirty = true;
        void this.sync();
      }
    }, intervalMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    try {
      this.db.close();
    } catch {}
  }
}

// Module-level manager cache keyed by group folder name
const managers = new Map<string, MemoryIndexManager>();

export async function getOrCreateMemoryManager(
  folder: string,
): Promise<MemoryIndexManager | null> {
  if (!MEMORY_SEARCH_ENABLED) return null;
  if (!MEMORY_SEARCH_GEMINI_API_KEY) {
    logger.warn(
      'Memory search enabled but MEMORY_SEARCH_GEMINI_API_KEY not set',
    );
    return null;
  }

  const existing = managers.get(folder);
  if (existing) return existing;

  const workspaceDir = path.join(GROUPS_DIR, folder);
  const dbDir = path.join(STORE_DIR, folder);
  await fs.mkdir(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'embeddings.db');

  const mgr = new MemoryIndexManager(
    workspaceDir,
    dbPath,
    MEMORY_SEARCH_EXTRA_PATHS,
    MEMORY_SEARCH_GEMINI_API_KEY,
    MEMORY_SEARCH_MODEL,
    MEMORY_SEARCH_RPM_LIMIT,
    MEMORY_SEARCH_RPD_SESSION_BUDGET,
    MEMORY_SEARCH_MAX_RESULTS,
    MEMORY_SEARCH_MIN_SCORE,
  );

  try {
    await mgr.init();
    managers.set(folder, mgr);
    // Kick off initial sync in background, then sync daily to catch any gaps
    void mgr.sync();
    mgr.startPeriodicSync(24 * 60 * 60 * 1000);
    return mgr;
  } catch (err) {
    logger.error({ err, folder }, 'Failed to initialize memory index manager');
    return null;
  }
}

export async function closeAllMemoryManagers(): Promise<void> {
  await Promise.all(Array.from(managers.values()).map((m) => m.close()));
  managers.clear();
}

/** Format memory search results as XML for injection into the agent prompt. */
export function formatMemoryContext(results: MemorySearchResult[]): string {
  if (results.length === 0) return '';
  const items = results
    .map(
      (r) =>
        `  <result path="${escapeXmlAttr(r.path)}" lines="${r.startLine}-${r.endLine}" score="${r.score.toFixed(2)}">\n` +
        `    <snippet>${escapeXml(r.snippet)}</snippet>\n` +
        `  </result>`,
    )
    .join('\n');
  return `<memory_context>\n${items}\n</memory_context>`;
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}
