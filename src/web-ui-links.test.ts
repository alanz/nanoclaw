/**
 * Zettelkasten notes link to each other and to their reports relatively
 * (`../reports/x.md`), so a link survives a change of host, port or folder —
 * the dashboard URLs they used before named a group (`main`) that no longer
 * exists and a port that has since changed. The file viewer resolves them.
 */
import { describe, expect, it } from 'vitest';

import { DASHBOARD_HTML, reportLookupKey, resolveWorkspaceLink } from './web-ui.js';

describe('resolveWorkspaceLink', () => {
  const note = 'dm-with-alanz/zettel/notes/MEM-2026-01-01-a.md';

  it('resolves a relative link against the viewed file, inside its group folder', () => {
    expect(resolveWorkspaceLink(note, '../reports/2026-01-01-a.md')).toEqual({
      folder: 'dm-with-alanz',
      path: 'zettel/reports/2026-01-01-a.md',
    });
    expect(resolveWorkspaceLink(note, 'MEM-2026-01-02-b.md')).toEqual({
      folder: 'dm-with-alanz',
      path: 'zettel/notes/MEM-2026-01-02-b.md',
    });
    expect(resolveWorkspaceLink(note, './MEM-2026-01-02-b.md#refs')).toEqual({
      folder: 'dm-with-alanz',
      path: 'zettel/notes/MEM-2026-01-02-b.md',
    });
    expect(resolveWorkspaceLink(note, '../../zotero-md/224KRICZ.md')).toEqual({
      folder: 'dm-with-alanz',
      path: 'zotero-md/224KRICZ.md',
    });
    expect(resolveWorkspaceLink(note, '../../memory/USER%20profile.md')).toEqual({
      folder: 'dm-with-alanz',
      path: 'memory/USER profile.md',
    });
  });

  it('leaves alone links that are not relative file links', () => {
    for (const href of ['', '#section', '/abs/path.md', 'https://example.com/x', 'mailto:a@b.c', '#groups/x/files/y']) {
      expect(resolveWorkspaceLink(note, href)).toBeNull();
    }
  });

  it('never resolves outside the group folder', () => {
    expect(resolveWorkspaceLink(note, '../../../other-group/memory/x.md')).toBeNull();
    expect(resolveWorkspaceLink(note, '../../../../etc/passwd')).toBeNull();
  });

  it('is embedded in the page as working script', () => {
    const inline = [...DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const page = inline.find((js) => js.includes('function resolveWorkspaceLink'));
    expect(page).toBeDefined();
    // Parses: an escaping slip in the template literal would break the whole page.
    expect(() => new Function(page!)).not.toThrow();
    const fn = new Function(
      `${page!.match(/function resolveWorkspaceLink[\s\S]*?\n {0,2}}\n/)![0]}; return resolveWorkspaceLink;`,
    )();
    expect(fn('g/zettel/notes/a.md', '../reports/r.md')).toEqual({ folder: 'g', path: 'zettel/reports/r.md' });
  });
});

describe('reportLookupKey', () => {
  it('matches a report under memory/ (committed before the move) or zettel/ (after)', () => {
    expect(reportLookupKey('zettel/reports/2026-01-01-a.md')).toBe('reports/2026-01-01-a.md');
    expect(reportLookupKey('memory/reports/2026-01-01-a.md')).toBe('reports/2026-01-01-a.md');
  });

  it('is null for anything that is not a report', () => {
    expect(reportLookupKey('zettel/notes/MEM-a.md')).toBeNull();
    expect(reportLookupKey('memory/digests/x.md')).toBeNull();
    expect(reportLookupKey('../reports/x.md')).toBeNull();
  });
});
