/**
 * The Zotero library is searchable as source `zotero`, in the group it syncs
 * into only (specs/memory.allium, MemoryFilesWithinWorkspace).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ ZOTERO_GROUP_FOLDER: 'dm-with-alanz', ZOTERO_POLL_INTERVAL: 3_600_000 }));
vi.mock('./monitor.js', () => ({ startZoteroMonitor: vi.fn() }));

import { workspaceIndexDirs } from '../../memory/workspace-dirs.js';
import './index.js';

describe('zotero-md in memory search', () => {
  it('is an index source in the library group, not in others', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-index-')));
    try {
      for (const folder of ['dm-with-alanz', 'other'])
        fs.mkdirSync(path.join(root, folder, 'zotero-md'), { recursive: true });
      expect(workspaceIndexDirs(path.join(root, 'dm-with-alanz'))).toContainEqual({
        dir: path.join(root, 'dm-with-alanz', 'zotero-md'),
        source: 'zotero',
      });
      expect(workspaceIndexDirs(path.join(root, 'other')).map((d) => d.source)).not.toContain('zotero');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
