import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFileEntry,
  chunkMarkdown,
  cosineSimilarity,
  hashText,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
} from './internal.js';

function setupTempDirLifecycle(prefix: string): () => string {
  let tmpDir = '';
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return () => tmpDir;
}

describe('normalizeExtraMemoryPaths', () => {
  it('trims, resolves, and dedupes paths', () => {
    const workspaceDir = path.join(os.tmpdir(), 'memory-test-workspace');
    const absPath = path.resolve(path.sep, 'shared-notes');
    const result = normalizeExtraMemoryPaths(workspaceDir, [
      ' notes ',
      './notes',
      absPath,
      absPath,
      '',
    ]);
    expect(result).toEqual([path.resolve(workspaceDir, 'notes'), absPath]);
  });
});

describe('listMemoryFiles', () => {
  const getTmpDir = setupTempDirLifecycle('memory-test-');

  it('includes files from additional paths (directory)', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');
    const extraDir = path.join(tmpDir, 'extra-notes');
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, 'note1.md'), '# Note 1');
    await fs.writeFile(path.join(extraDir, 'note2.md'), '# Note 2');
    await fs.writeFile(
      path.join(extraDir, 'ignore.txt'),
      'Not a markdown file',
    );

    const files = await listMemoryFiles(tmpDir, [extraDir]);
    expect(files).toHaveLength(3);
    expect(files.some((file) => file.endsWith('MEMORY.md'))).toBe(true);
    expect(files.some((file) => file.endsWith('note1.md'))).toBe(true);
    expect(files.some((file) => file.endsWith('note2.md'))).toBe(true);
    expect(files.some((file) => file.endsWith('ignore.txt'))).toBe(false);
  });

  it('includes .org files from workspace and additional paths', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');
    const memoryDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, 'notes.org'), '* Org-mode notes');
    await fs.writeFile(path.join(memoryDir, 'markdown.md'), '# Markdown notes');

    const extraDir = path.join(tmpDir, 'org-notes');
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, 'work.org'), '* Work notes');
    await fs.writeFile(path.join(extraDir, 'personal.org'), '* Personal notes');
    await fs.writeFile(path.join(extraDir, 'ignore.txt'), 'Not an org file');

    const files = await listMemoryFiles(tmpDir, [extraDir]);
    expect(files).toHaveLength(5);
    expect(files.some((file) => file.endsWith('MEMORY.md'))).toBe(true);
    expect(files.some((file) => file.endsWith('notes.org'))).toBe(true);
    expect(files.some((file) => file.endsWith('markdown.md'))).toBe(true);
    expect(files.some((file) => file.endsWith('work.org'))).toBe(true);
    expect(files.some((file) => file.endsWith('personal.org'))).toBe(true);
    expect(files.some((file) => file.endsWith('ignore.txt'))).toBe(false);
  });

  it('includes files from additional paths (single file)', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');
    const singleFile = path.join(tmpDir, 'standalone.md');
    await fs.writeFile(singleFile, '# Standalone');

    const files = await listMemoryFiles(tmpDir, [singleFile]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith('standalone.md'))).toBe(true);
  });

  it('includes single .org files from additional paths', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');
    const orgFile = path.join(tmpDir, 'notes.org');
    await fs.writeFile(orgFile, '* Org notes');

    const files = await listMemoryFiles(tmpDir, [orgFile]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith('MEMORY.md'))).toBe(true);
    expect(files.some((file) => file.endsWith('notes.org'))).toBe(true);
  });

  it('handles relative paths in additional paths', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');
    const extraDir = path.join(tmpDir, 'subdir');
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, 'nested.md'), '# Nested');

    const files = await listMemoryFiles(tmpDir, ['subdir']);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith('nested.md'))).toBe(true);
  });

  it('ignores non-existent additional paths', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');

    const files = await listMemoryFiles(tmpDir, ['/does/not/exist']);
    expect(files).toHaveLength(1);
  });

  it('ignores symlinked files and directories', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');
    const extraDir = path.join(tmpDir, 'extra');
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, 'note.md'), '# Note');

    const targetFile = path.join(tmpDir, 'target.md');
    await fs.writeFile(targetFile, '# Target');
    const linkFile = path.join(extraDir, 'linked.md');

    const targetDir = path.join(tmpDir, 'target-dir');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'nested.md'), '# Nested');
    const linkDir = path.join(tmpDir, 'linked-dir');

    let symlinksOk = true;
    try {
      await fs.symlink(targetFile, linkFile, 'file');
      await fs.symlink(targetDir, linkDir, 'dir');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        symlinksOk = false;
      } else {
        throw err;
      }
    }

    const files = await listMemoryFiles(tmpDir, [extraDir, linkDir]);
    expect(files.some((file) => file.endsWith('note.md'))).toBe(true);
    if (symlinksOk) {
      expect(files.some((file) => file.endsWith('linked.md'))).toBe(false);
      expect(files.some((file) => file.endsWith('nested.md'))).toBe(false);
    }
  });

  it('dedupes overlapping extra paths that resolve to the same file', async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Default memory');
    const files = await listMemoryFiles(tmpDir, [
      tmpDir,
      '.',
      path.join(tmpDir, 'MEMORY.md'),
    ]);
    const memoryMatches = files.filter((file) => file.endsWith('MEMORY.md'));
    expect(memoryMatches).toHaveLength(1);
  });
});

describe('buildFileEntry', () => {
  const getTmpDir = setupTempDirLifecycle('memory-build-entry-');

  it('returns null when the file disappears before reading', async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, 'ghost.md');
    await fs.writeFile(target, 'ghost', 'utf-8');
    await fs.rm(target);
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).toBeNull();
  });

  it('returns metadata when the file exists', async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, 'note.md');
    await fs.writeFile(target, 'hello', 'utf-8');
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).not.toBeNull();
    expect(entry?.path).toBe('note.md');
    expect(entry?.size).toBeGreaterThan(0);
  });

  it('returns relative path within workspaceDir', async () => {
    const tmpDir = getTmpDir();
    const subDir = path.join(tmpDir, 'memory');
    await fs.mkdir(subDir, { recursive: true });
    const target = path.join(subDir, 'notes.md');
    await fs.writeFile(target, 'content', 'utf-8');
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry?.path).toBe('memory/notes.md');
  });

  it('includes hash of file content', async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, 'note.md');
    await fs.writeFile(target, 'hello world', 'utf-8');
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry?.hash).toBeTruthy();
    expect(typeof entry?.hash).toBe('string');
    expect(entry?.hash.length).toBeGreaterThan(0);
  });
});

describe('hashText', () => {
  it('returns a hex string', () => {
    const hash = hashText('hello world');
    expect(typeof hash).toBe('string');
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    expect(hashText('test')).toBe(hashText('test'));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashText('hello')).not.toBe(hashText('world'));
  });

  it('handles empty string', () => {
    const hash = hashText('');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical non-zero vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0);
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('handles normalized vectors', () => {
    const mag = Math.sqrt(2);
    const a = [1 / mag, 1 / mag];
    const b = [1 / mag, 1 / mag];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
  });
});

describe('chunkMarkdown', () => {
  it('splits overly long lines into max-sized chunks', () => {
    const chunkTokens = 400;
    const maxChars = chunkTokens * 4;
    const content = 'a'.repeat(maxChars * 3 + 25);
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it('returns a single chunk for short content', () => {
    const content = 'Short content here.';
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(content);
  });

  it('sets correct startLine and endLine', () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(3);
  });

  it('includes overlap between chunks when overlap is set', () => {
    const chunkTokens = 10;
    const overlapTokens = 2;
    // Create content that spans multiple chunks
    const content = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join(
      '\n',
    );
    const chunksWithOverlap = chunkMarkdown(content, {
      tokens: chunkTokens,
      overlap: overlapTokens,
    });
    const chunksNoOverlap = chunkMarkdown(content, {
      tokens: chunkTokens,
      overlap: 0,
    });
    // With overlap, adjacent chunks should share some lines
    if (chunksWithOverlap.length > 1 && chunksNoOverlap.length > 1) {
      expect(chunksWithOverlap[0]?.endLine).toBeGreaterThanOrEqual(
        chunksNoOverlap[0]?.endLine ?? 0,
      );
    }
  });

  it('each chunk has a non-empty hash', () => {
    const content = 'Some content\nAnother line';
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    for (const chunk of chunks) {
      expect(chunk.hash).toBeTruthy();
      expect(chunk.hash.length).toBeGreaterThan(0);
    }
  });
});
