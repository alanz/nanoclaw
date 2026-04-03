import path from 'path';

import { describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  isValidGroupFolder,
  isValidSpecialistTypeName,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveSpecialistGroupFolderPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved).toBe(path.join(GROUPS_DIR, 'family-chat'));
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});

describe('isValidSpecialistTypeName', () => {
  it('accepts lowercase alphanumeric names', () => {
    expect(isValidSpecialistTypeName('researcher')).toBe(true);
    expect(isValidSpecialistTypeName('code_reviewer')).toBe(true);
    expect(isValidSpecialistTypeName('memory')).toBe(true);
  });

  it('rejects names starting with a digit or uppercase', () => {
    expect(isValidSpecialistTypeName('1researcher')).toBe(false);
    expect(isValidSpecialistTypeName('Researcher')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSpecialistTypeName('')).toBe(false);
  });

  it('rejects names containing slashes or dots', () => {
    expect(isValidSpecialistTypeName('../../etc')).toBe(false);
    expect(isValidSpecialistTypeName('re/searcher')).toBe(false);
  });
});

describe('resolveSpecialistGroupFolderPath', () => {
  it('resolves to groups/specialists/{name}', () => {
    const resolved = resolveSpecialistGroupFolderPath('researcher');
    expect(resolved).toBe(path.join(GROUPS_DIR, 'specialists', 'researcher'));
  });

  it('throws for invalid type names', () => {
    expect(() => resolveSpecialistGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveSpecialistGroupFolderPath('Researcher')).toThrow();
    expect(() => resolveSpecialistGroupFolderPath('')).toThrow();
  });
});
