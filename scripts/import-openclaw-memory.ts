/**
 * One-time migration: import ~/Sync/org chunks from OpenClaw's embedding index
 * into NanoClaw's groups/main/embeddings.db.
 *
 * Run once before starting NanoClaw with MEMORY_SEARCH_ENABLED=true:
 *   npx tsx scripts/import-openclaw-memory.ts
 *
 * OpenClaw's workspace is 2 levels below HOME, NanoClaw's is 3 levels below HOME
 * (groups/main/ inside the project). Paths are remapped on import so NanoClaw's
 * sync recognises them as already-indexed and skips re-embedding.
 */

import path from 'node:path';

import Database from 'better-sqlite3';

import { GROUPS_DIR, STORE_DIR } from '../src/config.js';
import { ensureMemoryIndexSchema } from '../src/memory/schema.js';
import { loadSqliteVecExtension } from '../src/memory/sqlite-vec.js';

const HOME_DIR = process.env.HOME ?? '/Users/alanz';
const SOURCE_DB = path.join(HOME_DIR, '.openclaw', 'memory', 'main.sqlite');
const TARGET_DB = path.join(STORE_DIR, 'main', 'embeddings.db');
const TARGET_WORKSPACE = path.join(GROUPS_DIR, 'main');

const PATH_FILTER = '../../Sync/org/%';
const VECTOR_TABLE = 'chunks_vec';
const FTS_TABLE = 'chunks_fts';
const CACHE_TABLE = 'embedding_cache';
const VECTOR_DIMS = 3072;

/**
 * Convert an OpenClaw-relative path to a NanoClaw-relative path.
 *
 * OpenClaw stores paths like "../../Sync/org/file.org" relative to its workspace
 * (2 levels below HOME). Strip the leading "../" segments, resolve from HOME,
 * then re-relativize from NanoClaw's workspaceDir (3 levels below HOME).
 *
 * e.g. "../../Sync/org/foo.org"
 *   → strip leading ../ → "Sync/org/foo.org"
 *   → resolve from HOME → "/Users/alanz/Sync/org/foo.org"
 *   → relative from TARGET_WORKSPACE → "../../../Sync/org/foo.org"
 */
function remapPath(openclaw_path: string): string {
  const stripped = openclaw_path.replace(/^(\.\.\/)+/, '');
  const abs = path.join(HOME_DIR, stripped);
  return path.relative(TARGET_WORKSPACE, abs);
}

/**
 * Remap an OpenClaw chunk ID to a NanoClaw chunk ID.
 * IDs are "<path>:<startLine>:<endLine>:<hash>" — only the path prefix changes.
 */
function remapChunkId(openclaw_id: string, openclaw_path: string, new_path: string): string {
  if (openclaw_id.startsWith(openclaw_path)) {
    return new_path + openclaw_id.slice(openclaw_path.length);
  }
  return openclaw_id;
}

async function main(): Promise<void> {
  console.log(`Source: ${SOURCE_DB}`);
  console.log(`Target: ${TARGET_DB}`);
  console.log(`Target workspace: ${TARGET_WORKSPACE}`);

  // Verify path remapping with a sample
  const sample = remapPath('../../Sync/org/gtd.org');
  console.log(`Path remapping sample: ../../Sync/org/gtd.org → ${sample}`);

  // Open source DB (read-only)
  const src = new Database(SOURCE_DB, { readonly: true });

  // Open target DB (create if absent)
  const dst = new Database(TARGET_DB);
  dst.pragma('journal_mode = WAL');

  // Load sqlite-vec into target for vector virtual table
  const vecResult = await loadSqliteVecExtension({ db: dst });
  if (!vecResult.ok) {
    console.error(`WARNING: sqlite-vec failed to load: ${vecResult.error}`);
    console.error('Vector table will not be created; FTS-only search will be available.');
  } else {
    const ver = dst.prepare('SELECT vec_version() AS v').get() as { v: string };
    console.log(`sqlite-vec loaded: ${ver.v}`);

    dst.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding float[${VECTOR_DIMS}]\n` +
        `);`,
    );
  }

  // Create standard tables
  ensureMemoryIndexSchema({ db: dst, embeddingCacheTable: CACHE_TABLE, ftsTable: FTS_TABLE });

  // Write meta row
  const META_KEY = 'memory_index_meta_v1';
  const existingMeta = dst.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY);
  if (!existingMeta) {
    dst.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      META_KEY,
      JSON.stringify({
        model: 'gemini-embedding-001',
        provider: 'gemini',
        vectorDims: VECTOR_DIMS,
        chunkTokens: 400,
        chunkOverlap: 80,
        sources: ['memory'],
      }),
    );
    console.log('Wrote meta row');
  } else {
    console.log('Meta row already exists, skipping');
  }

  // --- Purge any previously migrated rows with wrong paths ---
  // Old migrations used OpenClaw-relative paths (e.g. ../../Sync/org/…).
  // Wipe them so INSERT OR IGNORE doesn't skip the corrected entries.
  const OLD_PATH_FILTER = '../../Sync/org/%';
  const oldFileCount = (
    dst.prepare('SELECT COUNT(*) AS n FROM files WHERE path LIKE ?').get(OLD_PATH_FILTER) as { n: number }
  ).n;
  if (oldFileCount > 0) {
    console.log(`Purging ${oldFileCount} old-format file entries (wrong relative depth)…`);
    const oldPaths = (
      dst.prepare('SELECT path FROM files WHERE path LIKE ?').all(OLD_PATH_FILTER) as Array<{ path: string }>
    ).map((r) => r.path);

    const purgeInTx = dst.transaction((paths: string[]) => {
      for (const p of paths) {
        // Delete from chunks_fts and chunks_vec via chunk IDs for this path
        const chunkIds = (
          dst.prepare('SELECT id FROM chunks WHERE path = ?').all(p) as Array<{ id: string }>
        ).map((r) => r.id);
        for (const cid of chunkIds) {
          dst.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`).run(cid);
          if (vecResult.ok) {
            try { dst.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(cid); } catch {}
          }
        }
        dst.prepare('DELETE FROM chunks WHERE path = ?').run(p);
        dst.prepare('DELETE FROM files WHERE path = ?').run(p);
      }
    });

    const PURGE_BATCH = 200;
    for (let i = 0; i < oldPaths.length; i += PURGE_BATCH) {
      purgeInTx(oldPaths.slice(i, i + PURGE_BATCH));
      process.stdout.write(`\r  purged: ${Math.min(i + PURGE_BATCH, oldPaths.length)} / ${oldPaths.length}`);
    }
    console.log();
  }

  // --- Count source rows ---
  const srcFileCount = (
    src.prepare('SELECT COUNT(*) AS n FROM files WHERE path LIKE ?').get(PATH_FILTER) as { n: number }
  ).n;
  const srcChunkCount = (
    src.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path LIKE ?').get(PATH_FILTER) as { n: number }
  ).n;
  console.log(`Source: ${srcFileCount} files, ${srcChunkCount} chunks`);

  // --- Copy files (with remapped paths) ---
  console.log('Copying files…');
  const insertFile = dst.prepare(
    'INSERT OR IGNORE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)',
  );
  const srcFiles = src
    .prepare('SELECT path, source, hash, mtime, size FROM files WHERE path LIKE ?')
    .all(PATH_FILTER) as Array<{
    path: string;
    source: string;
    hash: string;
    mtime: number;
    size: number;
  }>;

  let filesCopied = 0;
  const copyFilesInTx = dst.transaction(() => {
    for (const row of srcFiles) {
      const newPath = remapPath(row.path);
      const result = insertFile.run(newPath, row.source, row.hash, row.mtime, row.size);
      if (result.changes > 0) filesCopied++;
    }
  });
  copyFilesInTx();
  console.log(`Files: ${filesCopied} inserted (${srcFiles.length - filesCopied} skipped)`);

  // --- Copy chunks + vector + FTS (with remapped paths and IDs) ---
  console.log('Copying chunks…');

  const insertChunk = dst.prepare(
    'INSERT OR IGNORE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertVec = vecResult.ok
    ? dst.prepare(`INSERT OR IGNORE INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
    : null;
  const insertFts = dst.prepare(
    `INSERT INTO ${FTS_TABLE} (id, path, source, model, start_line, end_line, text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const srcChunks = src
    .prepare(
      'SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at ' +
        'FROM chunks WHERE path LIKE ?',
    )
    .all(PATH_FILTER) as Array<{
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    hash: string;
    model: string;
    text: string;
    embedding: string;
    updated_at: number;
  }>;

  let chunksCopied = 0;
  let vecInserted = 0;
  let vecErrors = 0;

  const copyChunksInTx = dst.transaction((batch: typeof srcChunks) => {
    for (const row of batch) {
      const newPath = remapPath(row.path);
      const newId = remapChunkId(row.id, row.path, newPath);

      const res = insertChunk.run(
        newId,
        newPath,
        row.source,
        row.start_line,
        row.end_line,
        row.hash,
        row.model,
        row.text,
        row.embedding,
        row.updated_at,
      );

      if (res.changes === 0) continue;
      chunksCopied++;

      insertFts.run(newId, newPath, row.source, row.model, row.start_line, row.end_line, row.text);

      if (insertVec) {
        try {
          const floats = JSON.parse(row.embedding) as number[];
          const blob = Buffer.from(new Float32Array(floats).buffer);
          insertVec.run(newId, blob);
          vecInserted++;
        } catch {
          vecErrors++;
        }
      }
    }
  });

  const BATCH_SIZE = 500;
  for (let i = 0; i < srcChunks.length; i += BATCH_SIZE) {
    copyChunksInTx(srcChunks.slice(i, i + BATCH_SIZE));
    process.stdout.write(`\r  chunks: ${Math.min(i + BATCH_SIZE, srcChunks.length)} / ${srcChunks.length}`);
  }
  console.log();
  console.log(
    `Chunks: ${chunksCopied} inserted, ` +
      (insertVec ? `${vecInserted} vectors, ${vecErrors} vec errors` : 'no vector table'),
  );

  // --- Copy embedding_cache (gemini only, no path dependence) ---
  console.log('Copying embedding_cache…');
  const srcCache = src
    .prepare(
      "SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM embedding_cache WHERE provider = 'gemini'",
    )
    .all() as Array<{
    provider: string;
    model: string;
    provider_key: string;
    hash: string;
    embedding: string;
    dims: number | null;
    updated_at: number;
  }>;

  const insertCache = dst.prepare(
    `INSERT OR IGNORE INTO ${CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at) ` +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  let cacheCopied = 0;
  const copyCacheInTx = dst.transaction((batch: typeof srcCache) => {
    for (const row of batch) {
      const res = insertCache.run(
        row.provider, row.model, row.provider_key, row.hash,
        row.embedding, row.dims, row.updated_at,
      );
      if (res.changes > 0) cacheCopied++;
    }
  });

  for (let i = 0; i < srcCache.length; i += BATCH_SIZE) {
    copyCacheInTx(srcCache.slice(i, i + BATCH_SIZE));
  }
  console.log(`Cache: ${cacheCopied} / ${srcCache.length} rows inserted`);

  // --- Final counts ---
  const dstFileCount = (dst.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
  const dstChunkCount = (dst.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  const dstCacheCount = (dst.prepare(`SELECT COUNT(*) AS n FROM ${CACHE_TABLE}`).get() as { n: number }).n;

  console.log('\nDone.');
  console.log(`  files:  ${dstFileCount}`);
  console.log(`  chunks: ${dstChunkCount}`);
  console.log(`  cache:  ${dstCacheCount}`);

  // Verify a sample path
  const sampleFile = dst.prepare("SELECT path FROM files WHERE path LIKE '../../../Sync/org/%' LIMIT 1").get() as { path: string } | undefined;
  if (sampleFile) {
    console.log(`  sample path: ${sampleFile.path}`);
  }

  src.close();
  dst.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
