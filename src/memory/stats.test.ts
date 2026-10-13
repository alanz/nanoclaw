/** The dashboard's index health panel reads MemoryIndexManager.stats(). */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { MemoryIndexManager } from './manager.js';

let root: string;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('memory index stats', () => {
  it('reports files and chunks per source, sync state and the embedding quota', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-stats-')));
    const memory = path.join(root, 'memory');
    fs.mkdirSync(memory);
    fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
    fs.writeFileSync(path.join(memory, 'b.md'), '# B\n\nBeta.\n');
    const m = new MemoryIndexManager(
      'ag-main',
      'main',
      memory,
      path.join(root, 'index.db'),
      'k',
      'gemini-embedding-001',
    );
    await m.init();
    await vi.waitFor(() => expect(m.stats()?.lastSyncAt).not.toBeNull(), { timeout: 10_000 });

    const s = m.stats()!;
    expect(s).toMatchObject({ groupId: 'ag-main', groupFolder: 'main', syncing: false, dirty: false });
    expect(s.sources).toEqual([{ source: 'memory', files: 2, chunks: 2 }]);
    expect(s.quota.rpdUsed).toBe(2);
    expect(s.quota.rpdStoppedUntil).toBeNull();
    expect(s).toMatchObject({
      vectorSearch: true,
      vectorError: null,
      vectorState: 'clean',
      lastVectorRepair: { removed: 0, added: 0, failed: 0 },
      lastSync: { outcome: 'completed', indexed: 2, skipped: 0, removed: 0, incomplete: 0 },
      settingsCurrent: true,
      reindex: null,
      lastFullReindex: { result: 'completed', files: 2, reason: expect.stringContaining('first full build') },
      cache: { rows: 2, unused: 0 },
      lastCachePrune: { removed: 0 },
      warnings: [],
    });
    expect(s.db.bytes).toBeGreaterThan(0);

    await m.close();
    expect(m.stats()).toBeNull();
  });

  it('turns an interrupted re-index and drifted vectors into warnings', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-stats-')));
    const memory = path.join(root, 'memory');
    fs.mkdirSync(memory);
    fs.writeFileSync(path.join(memory, 'a.md'), '# A\n\nAlpha.\n');
    const dbPath = path.join(root, 'index.db');
    const m = new MemoryIndexManager('ag-main', 'main', memory, dbPath, 'k', 'gemini-embedding-001');
    await m.init();
    await vi.waitFor(() => expect(m.stats()?.lastSyncAt).not.toBeNull(), { timeout: 10_000 });

    // As a host that died mid-pass leaves it, and as a failed vector write marks it.
    const db = new Database(dbPath);
    db.prepare("UPDATE meta SET value = json_set(value, '$.result', 'running') WHERE key = 'last_full_reindex'").run();
    db.prepare("UPDATE meta SET value = 'needs_repair' WHERE key = 'vector_state'").run();
    db.close();

    const s = m.stats()!;
    expect(s.lastFullReindex?.result).toBe('interrupted');
    expect(s.vectorState).toBe('needs_repair');
    expect(s.warnings).toEqual([
      'Vector rows need repair; the next sync repairs them',
      'Last full re-index interrupted; it runs again at the next start',
    ]);
    await m.close();
  });
});
