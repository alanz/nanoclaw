/**
 * Dashboard links sent in chat before a file moved: v1's group `main`, and
 * memory/notes/ … from before the Zettelkasten moved to zettel/ (resolveLegacyLink).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveLegacyLink } from './web-ui.js';

let groupsDir: string;
let ctx: { groupsDir: string; folders: string[]; mainFolder: string | null };

function file(rel: string): void {
  const abs = path.join(groupsDir, 'dm', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
}

beforeAll(() => {
  groupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ui-legacy-'));
  ctx = { groupsDir, folders: ['dm', 'other'], mainFolder: 'dm' };
  file('zettel/notes/MEM-2026-06-22-recall.md');
  file('zettel/reports/2026-06-22-recall.md');
  file('zettel/drafts/d.md');
  file('zettel/digests/2026-06-16-synthesis-scan.md');
  file('memory/digests/2026-06-16-mozilla-ai-rss.md');
  file('zettel/research-topics.md');
  file('memory/sessions/2026-06-01-1946.md');
  file('memory/notes with space.md');
});

afterAll(() => {
  fs.rmSync(groupsDir, { recursive: true, force: true });
});

describe('resolveLegacyLink', () => {
  it('leaves a link that works unchanged', () => {
    expect(resolveLegacyLink('dm', 'zettel/notes/MEM-2026-06-22-recall.md', ctx)).toEqual({
      folder: 'dm',
      path: 'zettel/notes/MEM-2026-06-22-recall.md',
    });
    expect(resolveLegacyLink('dm', 'memory/sessions/2026-06-01-1946.md', ctx)?.path).toBe(
      'memory/sessions/2026-06-01-1946.md',
    );
  });

  it('maps memory/{notes,reports,drafts}/ and research-topics to zettel/', () => {
    expect(resolveLegacyLink('dm', 'memory/notes/MEM-2026-06-22-recall.md', ctx)?.path).toBe(
      'zettel/notes/MEM-2026-06-22-recall.md',
    );
    expect(resolveLegacyLink('dm', 'memory/reports/2026-06-22-recall.md', ctx)?.path).toBe(
      'zettel/reports/2026-06-22-recall.md',
    );
    expect(resolveLegacyLink('dm', 'memory/drafts/d.md', ctx)?.path).toBe('zettel/drafts/d.md');
    expect(resolveLegacyLink('dm', 'memory/research-topics.md', ctx)?.path).toBe('zettel/research-topics.md');
  });

  it('maps a digest only if it moved', () => {
    expect(resolveLegacyLink('dm', 'memory/digests/2026-06-16-synthesis-scan.md', ctx)?.path).toBe(
      'zettel/digests/2026-06-16-synthesis-scan.md',
    );
    expect(resolveLegacyLink('dm', 'memory/digests/2026-06-16-mozilla-ai-rss.md', ctx)?.path).toBe(
      'memory/digests/2026-06-16-mozilla-ai-rss.md',
    );
  });

  it("maps v1's group `main` to the current main group, and v1 researcher reports", () => {
    expect(resolveLegacyLink('main', 'memory/notes/MEM-2026-06-22-recall.md', ctx)).toEqual({
      folder: 'dm',
      path: 'zettel/notes/MEM-2026-06-22-recall.md',
    });
    expect(resolveLegacyLink('main', 'agents/researcher/reports/2026-06-22-recall.md', ctx)?.path).toBe(
      'zettel/reports/2026-06-22-recall.md',
    );
    expect(resolveLegacyLink('main', null, ctx)).toEqual({ folder: 'dm', path: null });
  });

  it('drops a leaked agent/ prefix and decodes escaped paths', () => {
    expect(resolveLegacyLink('dm', 'agent/memory/notes/MEM-2026-06-22-recall.md', ctx)?.path).toBe(
      'zettel/notes/MEM-2026-06-22-recall.md',
    );
    expect(resolveLegacyLink('dm', 'memory/notes%20with%20space.md', ctx)?.path).toBe('memory/notes with space.md');
  });

  it('is null for missing files, unknown groups, and paths leaving the group', () => {
    expect(resolveLegacyLink('dm', 'memory/notes/MEM-gone.md', ctx)).toBeNull();
    expect(resolveLegacyLink('nope', 'zettel/research-topics.md', ctx)).toBeNull();
    expect(resolveLegacyLink('main', null, { ...ctx, mainFolder: null })).toBeNull();
    expect(resolveLegacyLink('dm', '../other/x', ctx)).toBeNull();
    expect(resolveLegacyLink('dm', 'zettel/notes', ctx)).toBeNull(); // a directory, not a file
  });
});
