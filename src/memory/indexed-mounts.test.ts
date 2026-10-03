/**
 * Mounts marked `index` are searched alongside a group's own memory/ — the
 * org-files search memoryIndexDirs was meant to give the main group, and
 * never did: it was read from container.json, which is regenerated from the
 * DB at every spawn and never carried the field.
 *
 * An indexed file's stored path is the one the container sees it at
 * (`extra/<mount>/…`). It has to be exactly that, and stable: a path that
 * differed from the mount point would not resolve in the container, and one
 * that changed between syncs would index the same file twice.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ allowlist: '' }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return env.allowlist;
    },
  };
});
// Nothing leaves the machine: fixed vectors stand in for Gemini, and the file
// watcher is inert (the test drives sync itself).
vi.mock('./embeddings.js', () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: 'gemini-embedding-001',
  createGeminiEmbeddingProvider: () => ({
    embedBatch: async (texts: string[]) => texts.map(() => new Array(3072).fill(0.01)),
  }),
}));
vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) },
}));

import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { runMigrations } from '../db/migrations/index.js';
import { indexedMountDirs, MemoryIndexManager } from './manager.js';

let root: string;
let org: string;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'indexed-mounts-')));
  org = path.join(root, 'Sync', 'org');
  fs.mkdirSync(path.join(org, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(org, 'gtd.org'), '* TODO write the report\nSome notes.\n');
  fs.writeFileSync(path.join(org, 'projects', 'nanoclaw.org'), '* Nanoclaw\nThe fork.\n');
  env.allowlist = path.join(root, 'mount-allowlist.json');
  fs.writeFileSync(
    env.allowlist,
    JSON.stringify({ allowedRoots: [{ path: path.join(root, 'Sync'), allowReadWrite: false }], blockedPatterns: [] }),
  );
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('indexedMountDirs', () => {
  it('returns only the mounts marked index that the allowlist accepts, under their container path', async () => {
    await createAgentGroup({ id: 'ag-main', name: 'Andy', folder: 'main', agent_provider: null, created_at: 'x' });
    await ensureContainerConfig('ag-main');
    fs.mkdirSync(path.join(root, 'elsewhere'));
    await updateContainerConfigJson('ag-main', 'additional_mounts', [
      { hostPath: org, containerPath: 'org', readonly: true, index: true },
      { hostPath: path.join(root, 'Sync'), containerPath: 'sync', readonly: true }, // not marked
      { hostPath: path.join(root, 'elsewhere'), containerPath: 'nope', index: true }, // outside the allowlist
    ]);

    expect(await indexedMountDirs('ag-main')).toEqual([{ dir: org, source: 'org', pathPrefix: 'extra/org' }]);
  });
});

describe('indexing a mount', () => {
  it('stores each file at its container mount point, once, across syncs', async () => {
    const memoryDir = path.join(root, 'memory');
    fs.mkdirSync(memoryDir);
    const manager = new MemoryIndexManager(
      'ag-main',
      'main',
      memoryDir,
      path.join(root, 'index.db'),
      'test-key',
      'gemini-embedding-001',
      [{ dir: org, source: 'org', pathPrefix: 'extra/org' }],
    );
    await manager.init();
    await manager.sync({ force: true });
    await manager.sync({ force: true }); // a second full sync must not add rows

    const rows = (manager as unknown as { index: { db: import('better-sqlite3').Database } }).index.db
      .prepare('SELECT path, source FROM files ORDER BY path')
      .all();
    expect(rows).toEqual([
      { path: 'extra/org/gtd.org', source: 'org' },
      { path: 'extra/org/projects/nanoclaw.org', source: 'org' },
    ]);
    await manager.close();
  });
});
