/**
 * Superseded Zettelkasten notes stay indexed but are left out of search unless
 * asked for (specs/memory.allium MemoryFile.superseded, MemorySearched;
 * memory-graph.allium NoNewLinksToSuperseded — link candidates come from this
 * search, so a superseded note is never offered as one).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
    embedQuery: async () => new Array(3072).fill(0.01),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { namesSupersededBy } from './index-db.js';
import { MemoryIndexManager } from './manager.js';

type WithLimiter = { rateLimiter: { acquirePermit: () => Promise<void> } };
type WithDb = { index: { db: import('better-sqlite3').Database } };

const note = (id: string, supersededBy: string | null) =>
  `---\ntype: note\nlinks: []\n${supersededBy ? `superseded_by: ${supersededBy}\n` : ''}---\n\n# ${id}\n\nAardvarks eat termites.\n`;

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'superseded-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('namesSupersededBy', () => {
  it('reads a non-empty superseded_by in the leading frontmatter, scalar or list', () => {
    expect(namesSupersededBy(note('a', 'MEM-2026-10-28-b'))).toBe(true);
    expect(namesSupersededBy('---\nsuperseded_by: [MEM-x]\n---\nbody\n')).toBe(true);
    expect(namesSupersededBy(note('a', null))).toBe(false);
    expect(namesSupersededBy('---\nsuperseded_by: []\n---\n')).toBe(false);
    expect(namesSupersededBy('---\nsuperseded_by: null\n---\n')).toBe(false);
    expect(namesSupersededBy('# body only\n\nsuperseded_by: MEM-x\n')).toBe(false);
  });
});

describe('search and superseded notes', () => {
  async function world(): Promise<MemoryIndexManager> {
    const groupDir = path.join(root, 'g');
    const notes = path.join(groupDir, 'zettel', 'notes');
    fs.mkdirSync(notes, { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'memory'));
    fs.writeFileSync(path.join(notes, 'MEM-old.md'), note('old', 'MEM-new'));
    fs.writeFileSync(path.join(notes, 'MEM-new.md'), note('new', null));
    const m = new MemoryIndexManager('ag-g', 'g', path.join(groupDir, 'memory'), path.join(root, 'm.db'), 'key', 'm', [
      { dir: path.join(groupDir, 'zettel'), source: 'zettel' },
    ]);
    (m as unknown as WithLimiter).rateLimiter = { acquirePermit: async () => {} };
    await m.init();
    await m.sync();
    return m;
  }
  const names = (r: { results: Array<{ path: string }> }) => r.results.map((x) => path.basename(x.path)).sort();

  it('leaves superseded notes out by default and includes them on request', async () => {
    const m = await world();
    expect(names(await m.search('aardvarks termites', { minScore: 0 }))).toEqual(['MEM-new.md']);
    expect(names(await m.search('aardvarks termites', { minScore: 0, includeSuperseded: true }))).toEqual([
      'MEM-new.md',
      'MEM-old.md',
    ]);
    await m.close();
  }, 20_000);

  it('learns the flag for a note indexed before it existed, without re-indexing it', async () => {
    const m = await world();
    const db = (m as unknown as WithDb).index.db;
    db.prepare('UPDATE files SET superseded = 0').run(); // as an index from before the column
    const chunksBefore = db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number };
    (m as unknown as { dirty: boolean }).dirty = true;
    await m.sync();
    const flags = db.prepare('SELECT path, superseded FROM files ORDER BY path').all() as Array<{
      path: string;
      superseded: number;
    }>;
    expect(flags.map((f) => [path.basename(f.path), f.superseded])).toEqual([
      ['MEM-new.md', 0],
      ['MEM-old.md', 1],
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual(chunksBefore);
    await m.close();
  }, 20_000);
});
