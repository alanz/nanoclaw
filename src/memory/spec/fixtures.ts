/**
 * Shared fixtures for the memory spec suite. The mocks themselves (the
 * embedding provider, the shared rate limiter, the file watcher) are declared
 * in each test file — vi.mock is per file — and drive the `Ctl` state below.
 *
 * Embeddings are deterministic: a text's vector is the unit vector whose
 * cosine with every query vector is the `cos=<n>` marker in the text (1 when
 * there is none), so a test can place a chunk at a chosen vector score.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { expect, vi } from 'vitest';

import type { MemoryIndexManager } from '../manager.js';

export const DIMS = 3072;

export function unitWithCosine(cos: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

export function vectorFor(text: string): number[] {
  const m = /cos=([0-9.]+)/.exec(text);
  return unitWithCosine(m ? Number(m[1]) : 1);
}

export interface Ctl {
  /** Every batch the provider was asked to embed. */
  batches: string[][];
  /** Throws for a batch when it returns an error. */
  batchError: ((texts: string[]) => Error | undefined) | null;
  /** Held batches wait on this. */
  gate: Promise<void> | null;
  queryFails: boolean;
  /** Configs the shared rate limiter was created with. */
  limiterConfigs: unknown[];
  /** The rate limiter's permit; replace to hold or refuse it. */
  permit: () => Promise<void>;
  /** Callbacks the watcher was subscribed with, by directory. */
  watchers: Map<string, (err: Error | null, events: Array<{ path: string; type: string }>) => void>;
}

export function newCtl(): Ctl {
  return {
    batches: [],
    batchError: null,
    gate: null,
    queryFails: false,
    limiterConfigs: [],
    permit: async () => {},
    watchers: new Map(),
  };
}

export function resetCtl(ctl: Ctl): void {
  Object.assign(ctl, newCtl());
}

export function fakeProvider(ctl: Ctl) {
  return {
    id: 'gemini',
    model: 'test',
    embedQuery: async () => {
      if (ctl.queryFails) throw new Error('query embedding unavailable');
      return unitWithCosine(1);
    },
    embedBatch: async (texts: string[]) => {
      ctl.batches.push(texts);
      if (ctl.gate) await ctl.gate;
      const err = ctl.batchError?.(texts);
      if (err) throw err;
      return texts.map(vectorFor);
    },
  };
}

export function fakeLimiter(ctl: Ctl) {
  return {
    acquirePermit: () => ctl.permit(),
    depleteQuotaForType: () => {},
    rpdResumeInMs: () => 24 * 60 * 60 * 1000,
    snapshot: () => ({
      rpmLimit: null,
      tpmLimit: null,
      rpdBudget: null,
      rpdUsed: 0,
      rpdWindowStart: null,
      coolDownUntil: null,
      rpdStoppedUntil: null,
    }),
  };
}

export function tempRoot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Wait until the manager has no sync running or queued. */
export async function settled(m: MemoryIndexManager): Promise<void> {
  await vi.waitFor(() => expect((m as unknown as { _syncing: boolean })._syncing).toBe(false), { timeout: 10_000 });
  await (m as unknown as { syncLock: Promise<void> }).syncLock;
}

/** A sync as a watcher event or the periodic timer starts it. */
export async function changed(m: MemoryIndexManager): Promise<void> {
  (m as unknown as { dirty: boolean }).dirty = true;
  await m.sync();
  await settled(m);
}

export interface FileRow {
  path: string;
  source: string;
  hash: string;
  superseded: number;
}
export interface ChunkRow {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  hash: string;
  text: string;
  updated_at: number;
}

/** The index as a reader sees it. */
export function readIndex(dbPath: string): {
  files: FileRow[];
  chunks: ChunkRow[];
  fts: string[];
  vec: string[];
  meta: Record<string, string>;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const has = (name: string) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name);
    return {
      files: db.prepare('SELECT path, source, hash, superseded FROM files ORDER BY path').all() as FileRow[],
      chunks: db
        .prepare('SELECT id, path, start_line, end_line, hash, text, updated_at FROM chunks ORDER BY path, start_line')
        .all() as ChunkRow[],
      fts: (db.prepare('SELECT id FROM chunks_fts ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id),
      vec: has('chunks_vec_rowids')
        ? (db.prepare('SELECT id FROM chunks_vec_rowids ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)
        : [],
      meta: Object.fromEntries(
        (db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map((r) => [
          r.key,
          r.value,
        ]),
      ),
    };
  } finally {
    db.close();
  }
}

export const FINGERPRINT_KEY = 'index_fingerprint_v2';
