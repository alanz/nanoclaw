import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

// Specialist type names: lowercase letters, digits, underscores, hyphens.
const SPECIALIST_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

export function isValidSpecialistTypeName(name: string): boolean {
  return SPECIALIST_TYPE_PATTERN.test(name);
}

/**
 * Resolve the group folder path for a specialist type.
 * Specialist folders live at `${GROUPS_DIR}/specialists/{typeName}/`.
 * This is separate from resolveGroupFolderPath because the path contains
 * a slash, which the generic validator rejects.
 */
export function resolveSpecialistGroupFolderPath(typeName: string): string {
  if (!isValidSpecialistTypeName(typeName)) {
    throw new Error(`Invalid specialist type name: "${typeName}"`);
  }
  const specialistsBaseDir = path.resolve(GROUPS_DIR, 'specialists');
  const folderPath = path.resolve(specialistsBaseDir, typeName);
  ensureWithinBase(specialistsBaseDir, folderPath);
  return folderPath;
}
