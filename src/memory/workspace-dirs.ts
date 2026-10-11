/**
 * Folders in a group's workspace that are indexed besides memory/
 * (specs/memory.allium, MemoryFilesWithinWorkspace): the Zettelkasten,
 * zettel/, and any folder another module registers for the groups it writes
 * into — e.g. the Zotero library's zotero-md/. Kept in its own file so both
 * the indexer (manager.ts) and the path invariant (rules.ts) read one list.
 */
import fs from 'fs';
import path from 'path';

export interface WorkspaceIndexDir {
  /** Folder name at the top of the group workspace, e.g. `zotero-md`. */
  subdir: string;
  /** Source name its files are indexed under, e.g. `zotero`. */
  source: string;
  /** Which groups have it; all groups when absent. */
  appliesTo?: (groupFolder: string) => boolean;
}

/**
 * The group's Zettelkasten: `groups/<folder>/zettel/`, kept apart from the
 * OKF memory/ tree because its rules are the opposite — notes are permanent
 * and never edited, where memory/ is updated and pruned in place.
 */
export const ZETTEL_DIR = 'zettel';

const registered: WorkspaceIndexDir[] = [{ subdir: ZETTEL_DIR, source: ZETTEL_DIR }];

/** Index a folder of a group's workspace alongside its memory/. Call at module load. */
export function registerMemoryWorkspaceDir(dir: WorkspaceIndexDir): void {
  if (!/^[A-Za-z0-9._-]+$/.test(dir.subdir) || dir.subdir.startsWith('.') || dir.subdir === 'memory') {
    throw new Error(`Not an indexable workspace folder name: ${dir.subdir}`);
  }
  if (registered.some((d) => d.subdir === dir.subdir))
    throw new Error(`Workspace folder already indexed: ${dir.subdir}`);
  registered.push(dir);
}

/** Every registered folder name — what the path invariant accepts besides memory/. */
export function workspaceIndexSubdirs(): string[] {
  return registered.map((d) => d.subdir);
}

/** The group's registered folders that exist, as index sources. Stored repo-relative, like memory/. */
export function workspaceIndexDirs(groupDir: string): Array<{ dir: string; source: string }> {
  const folder = path.basename(groupDir);
  return registered
    .filter((d) => !d.appliesTo || d.appliesTo(folder))
    .map((d) => ({ dir: path.join(groupDir, d.subdir), source: d.source }))
    .filter((d) => fs.existsSync(d.dir));
}
