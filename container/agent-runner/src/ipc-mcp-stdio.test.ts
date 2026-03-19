import { describe, it, expect } from 'vitest';
import { buildDashboardUrl } from './ipc-mcp-stdio.js';

describe('buildDashboardUrl', () => {
  const BASE = 'https://nanoclaw.example.ts.net';
  const FOLDER = 'main';

  it('returns null when webUiBaseUrl is null', () => {
    expect(buildDashboardUrl(null, FOLDER, '/workspace/CLAUDE.md')).toBeNull();
  });

  it('builds a file URL from an absolute workspace path', () => {
    expect(buildDashboardUrl(BASE, FOLDER, '/workspace/CLAUDE.md')).toBe(
      `${BASE}#groups/${FOLDER}/files/CLAUDE.md`,
    );
  });

  it('builds a file URL from a relative path', () => {
    expect(buildDashboardUrl(BASE, FOLDER, 'notes/todo.md')).toBe(
      `${BASE}#groups/${FOLDER}/files/notes/todo.md`,
    );
  });

  it('builds a file URL from workspace/ prefix (no leading slash)', () => {
    expect(buildDashboardUrl(BASE, FOLDER, 'workspace/CLAUDE.md')).toBe(
      `${BASE}#groups/${FOLDER}/files/CLAUDE.md`,
    );
  });

  it('strips extra leading slashes from relative path', () => {
    expect(buildDashboardUrl(BASE, FOLDER, '//notes/todo.md')).toBe(
      `${BASE}#groups/${FOLDER}/files/notes/todo.md`,
    );
  });

  it('builds a nested file URL', () => {
    expect(buildDashboardUrl(BASE, FOLDER, '/workspace/subdir/deep/file.json')).toBe(
      `${BASE}#groups/${FOLDER}/files/subdir/deep/file.json`,
    );
  });

  it('defaults to files tab when no file_path and no view', () => {
    expect(buildDashboardUrl(BASE, FOLDER)).toBe(
      `${BASE}#groups/${FOLDER}/files`,
    );
  });

  it('builds a chat view URL', () => {
    expect(buildDashboardUrl(BASE, FOLDER, undefined, 'chat')).toBe(
      `${BASE}#groups/${FOLDER}`,
    );
  });

  it('builds a tasks view URL', () => {
    expect(buildDashboardUrl(BASE, FOLDER, undefined, 'tasks')).toBe(
      `${BASE}#groups/${FOLDER}/tasks`,
    );
  });

  it('builds a files tab URL (no file selected)', () => {
    expect(buildDashboardUrl(BASE, FOLDER, undefined, 'files')).toBe(
      `${BASE}#groups/${FOLDER}/files`,
    );
  });

  it('uses correct group folder in URL', () => {
    expect(buildDashboardUrl(BASE, 'telegram_work', '/workspace/plan.md')).toBe(
      `${BASE}#groups/telegram_work/files/plan.md`,
    );
  });
});
