/**
 * Indexed roots and exclusions that are not settled when the host starts
 * (specs/memory.allium FileDiscovered, NoMemoryFilesForSpecialistGroups):
 * a registered workspace folder created after the manager started is indexed
 * on the next sync, and indexing waits for an exclusion owner to load.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const watched = vi.hoisted(() => [] as string[]);

vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
    embedQuery: async () => new Array(3072).fill(0.01),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: {
    subscribe: async (dir: string) => {
      watched.push(dir);
      return { unsubscribe: async () => {} };
    },
  },
}));

import {
  closeAllMemoryManagers,
  getMemoryManager,
  initMemoryManagers,
  MemoryIndexManager,
  registerMemoryGroupExclusion,
} from './manager.js';

type WithLimiter = { rateLimiter: { acquirePermit: () => Promise<void> } };

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'late-folders-')));
  watched.length = 0;
});
afterEach(async () => {
  await closeAllMemoryManagers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a workspace folder created after the manager started', () => {
  it('is indexed and watched on the next sync', async () => {
    const groupDir = path.join(root, 'g');
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'memory', 'index.md'), '# Index\n\nNothing yet.\n');
    const m = new MemoryIndexManager('ag-g', 'g', path.join(groupDir, 'memory'), path.join(root, 'm.db'), 'key', 'm');
    (m as unknown as WithLimiter).rateLimiter = { acquirePermit: async () => {} };
    await m.init();
    await m.sync();

    // The group's first committed report makes zettel/.
    fs.mkdirSync(path.join(groupDir, 'zettel', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'zettel', 'reports', 'r.md'), '# Report\n\nAbout aardvarks.\n');
    await m.sync();

    const db = (m as unknown as { index: { db: import('better-sqlite3').Database } }).index.db;
    const paths = (db.prepare('SELECT path, source FROM files').all() as Array<{ path: string; source: string }>).map(
      (r) => `${r.source}:${path.basename(r.path)}`,
    );
    expect(paths).toContain('zettel:r.md');
    expect(watched).toContain(path.join(groupDir, 'zettel'));
    await m.close();
  }, 20_000);
});

describe('an exclusion whose owner loads it later', () => {
  it('is waited for before any group is indexed', async () => {
    const late = new Set<string>();
    let release!: () => void;
    const loaded = new Promise<void>((r) => (release = r));
    registerMemoryGroupExclusion(
      (id) => late.has(id),
      async () => {
        await loaded;
      },
    );
    fs.mkdirSync(path.join(root, 'groups', 'spec', 'memory'), { recursive: true });

    const init = initMemoryManagers({
      dataDir: path.join(root, 'data'),
      groupsDir: path.join(root, 'groups'),
      apiKey: 'key',
      groups: [{ id: 'ag-late-spec', folder: 'spec' }],
      allowedFolders: new Set(['spec']),
    });
    // The owner loads its groups only now (its host start runs after memory's).
    late.add('ag-late-spec');
    release();
    await init;

    expect(getMemoryManager('ag-late-spec')).toBeUndefined();
  });
});
