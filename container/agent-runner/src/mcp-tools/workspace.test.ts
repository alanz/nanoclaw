import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildFileUrl, getFilePath, getFileUrl, parseFileUrl, readMeta } from './workspace.js';

// ── Pure URL helpers ──────────────────────────────────────────────────────────

describe('buildFileUrl', () => {
  it('strips /workspace/agent/ prefix so the path is relative to the group folder', () => {
    expect(buildFileUrl('https://host.ts.net', 'dm-with-alanz', '/workspace/agent/notes.md')).toBe(
      'https://host.ts.net/#groups/dm-with-alanz/files/notes.md',
    );
  });

  it('strips /workspace/agent/ for nested paths', () => {
    expect(buildFileUrl('https://host.ts.net', 'main', '/workspace/agent/memory/notes/file.md')).toBe(
      'https://host.ts.net/#groups/main/files/memory/notes/file.md',
    );
  });

  it('strips /workspace/ (non-agent path) leaving the relative segment', () => {
    expect(buildFileUrl('https://host.ts.net', 'main', '/workspace/outbox/result.txt')).toBe(
      'https://host.ts.net/#groups/main/files/outbox/result.txt',
    );
  });

  it('handles a bare filename (already relative, no leading slash)', () => {
    expect(buildFileUrl('https://host.ts.net', 'g', 'bare.md')).toBe(
      'https://host.ts.net/#groups/g/files/bare.md',
    );
  });

  it('works with different group folders', () => {
    expect(buildFileUrl('https://h.ts.net', 'research', '/workspace/agent/data.csv')).toBe(
      'https://h.ts.net/#groups/research/files/data.csv',
    );
  });
});

describe('parseFileUrl', () => {
  const base = 'https://host.ts.net';
  const folder = 'dm-with-alanz';

  it('round-trips with buildFileUrl for agent paths', () => {
    const original = '/workspace/agent/notes.md';
    const url = buildFileUrl(base, folder, original);
    expect(parseFileUrl(base, folder, url)).toBe('/workspace/agent/notes.md');
  });

  it('returns null for a URL from a different group', () => {
    const url = buildFileUrl(base, 'other-group', '/workspace/agent/f.md');
    expect(parseFileUrl(base, folder, url)).toBeNull();
  });

  it('returns null for a URL with a different base', () => {
    const url = 'https://other.ts.net/#groups/dm-with-alanz/files/agent/f.md';
    expect(parseFileUrl(base, folder, url)).toBeNull();
  });

  it('returns null for an unrelated URL', () => {
    expect(parseFileUrl(base, folder, 'https://example.com/foo')).toBeNull();
  });
});

// ── readMeta ──────────────────────────────────────────────────────────────────

describe('readMeta', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid meta file', () => {
    const p = path.join(tmpDir, 'nanoclaw_meta.json');
    fs.writeFileSync(p, JSON.stringify({ webUiBaseUrl: 'https://h.ts.net', groupFolder: 'main' }));
    expect(readMeta(p)).toEqual({ webUiBaseUrl: 'https://h.ts.net', groupFolder: 'main' });
  });

  it('returns null when the file is absent', () => {
    expect(readMeta(path.join(tmpDir, 'missing.json'))).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, 'not json');
    expect(readMeta(p)).toBeNull();
  });
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('getFileUrl tool definition', () => {
  it('has the correct name', () => {
    expect(getFileUrl.tool.name).toBe('get_file_url');
  });

  it('requires file_path parameter', () => {
    const required = getFileUrl.tool.inputSchema.required as string[];
    expect(required).toContain('file_path');
  });

  it('declares file_path as a string property', () => {
    const props = getFileUrl.tool.inputSchema.properties as Record<string, { type: string }>;
    expect(props.file_path?.type).toBe('string');
  });
});

describe('getFilePath tool definition', () => {
  it('has the correct name', () => {
    expect(getFilePath.tool.name).toBe('get_file_path');
  });

  it('requires url parameter', () => {
    const required = getFilePath.tool.inputSchema.required as string[];
    expect(required).toContain('url');
  });

  it('declares url as a string property', () => {
    const props = getFilePath.tool.inputSchema.properties as Record<string, { type: string }>;
    expect(props.url?.type).toBe('string');
  });
});
