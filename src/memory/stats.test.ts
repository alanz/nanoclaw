/** The dashboard's index health panel reads MemoryIndexManager.stats(). */
import fs from 'fs';
import os from 'os';
import path from 'path';
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

    await m.close();
    expect(m.stats()).toBeNull();
  });
});
