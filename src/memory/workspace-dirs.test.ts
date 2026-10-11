/**
 * Workspace folders indexed beside memory/ (specs/memory.allium,
 * MemoryFilesWithinWorkspace): the Zettelkasten always, and folders other
 * modules register for the groups they write into.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerMemoryWorkspaceDir, workspaceIndexDirs, workspaceIndexSubdirs } from './workspace-dirs.js';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dirs-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function group(folder: string, ...subdirs: string[]): string {
  const dir = path.join(root, folder);
  for (const s of subdirs) fs.mkdirSync(path.join(dir, s), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('workspace index folders', () => {
  it('a registered folder is indexed only in the groups it applies to, and only when it exists', () => {
    registerMemoryWorkspaceDir({ subdir: 'wd-lib', source: 'lib', appliesTo: (f) => f === 'mine' });
    expect(workspaceIndexSubdirs()).toContain('wd-lib');

    const mine = group('mine', 'zettel', 'wd-lib');
    expect(workspaceIndexDirs(mine)).toEqual([
      { dir: path.join(mine, 'zettel'), source: 'zettel' },
      { dir: path.join(mine, 'wd-lib'), source: 'lib' },
    ]);
    expect(workspaceIndexDirs(group('other', 'zettel', 'wd-lib'))).toEqual([
      { dir: path.join(root, 'other', 'zettel'), source: 'zettel' },
    ]);
    expect(workspaceIndexDirs(group('mine-empty'))).toEqual([]);
  });

  it('refuses names that are not a plain top-level folder, memory/ itself, or a second registration', () => {
    for (const subdir of ['', '../x', 'a/b', '.hidden', 'memory', 'zettel']) {
      expect(() => registerMemoryWorkspaceDir({ subdir, source: 's' })).toThrow();
    }
  });
});
