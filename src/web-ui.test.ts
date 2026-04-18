import { describe, expect, it } from 'vitest';

import { orgInlineMarkup, parseHash, parseNoteFrontmatter } from './web-ui.js';

describe('parseHash', () => {
  it('parses bare group list', () => {
    expect(parseHash('#groups')).toEqual({ section: 'groups', folder: null });
  });

  it('parses group chat tab (default)', () => {
    expect(parseHash('#groups/main')).toMatchObject({
      section: 'groups',
      folder: 'main',
      tab: 'chat',
    });
  });

  it('parses notes tab without note ID', () => {
    expect(parseHash('#groups/main/notes')).toMatchObject({
      section: 'groups',
      folder: 'main',
      tab: 'notes',
      noteId: null,
    });
  });

  it('parses notes tab with note ID', () => {
    expect(
      parseHash(
        '#groups/main/notes/MEM-2026-03-25-mozilla-cq-knowledge-commons',
      ),
    ).toMatchObject({
      section: 'groups',
      folder: 'main',
      tab: 'notes',
      noteId: 'MEM-2026-03-25-mozilla-cq-knowledge-commons',
    });
  });

  it('parses files tab without path', () => {
    expect(parseHash('#groups/main/files')).toMatchObject({
      section: 'groups',
      folder: 'main',
      tab: 'files',
      filePath: null,
    });
  });

  it('parses files tab with path', () => {
    expect(
      parseHash('#groups/main/files/memory/notes/MEM-2026-03-25-example.md'),
    ).toMatchObject({
      section: 'groups',
      folder: 'main',
      tab: 'files',
      filePath: 'memory/notes/MEM-2026-03-25-example.md',
    });
  });

  it('parses top-level sections', () => {
    expect(parseHash('#specialists')).toEqual({ section: 'specialists' });
    expect(parseHash('#feeds')).toEqual({ section: 'feeds' });
    expect(parseHash('#system')).toEqual({ section: 'system' });
    expect(parseHash('#overview')).toEqual({ section: 'overview' });
    expect(parseHash('#database')).toEqual({ section: 'database' });
  });

  it('does not set noteId for files tab', () => {
    const result = parseHash(
      '#groups/main/files/memory/notes/MEM-2026-03-25-example.md',
    );
    expect(result.noteId).toBeNull();
  });

  it('does not set filePath for notes tab', () => {
    const result = parseHash('#groups/main/notes/MEM-2026-03-25-example');
    expect(result.filePath).toBeNull();
  });
});

describe('parseNoteFrontmatter', () => {
  const NOTE = `---
id: MEM-2026-03-23-knowledge-half-life
created: 2026-03-23
keywords: [knowledge-decay, supersede, staleness]
tags: [memory-systems, zettelkasten]
links: [MEM-2026-03-23-dead-author-problem, MEM-2026-03-22-memory-reconstruction, MEM-2026-03-29-memory-kernel]
supersedes: null
---

Body text here.
`;

  it('parses links without brackets', () => {
    const result = parseNoteFrontmatter(NOTE);
    expect(result).not.toBeNull();
    expect(result!.links).toEqual([
      'MEM-2026-03-23-dead-author-problem',
      'MEM-2026-03-22-memory-reconstruction',
      'MEM-2026-03-29-memory-kernel',
    ]);
  });

  it('no link ID starts with [', () => {
    const result = parseNoteFrontmatter(NOTE);
    for (const id of result!.links) {
      expect(id).not.toMatch(/^\[/);
    }
  });

  it('no link ID ends with ]', () => {
    const result = parseNoteFrontmatter(NOTE);
    for (const id of result!.links) {
      expect(id).not.toMatch(/\]$/);
    }
  });

  it('returns empty array for synthesises when absent', () => {
    const result = parseNoteFrontmatter(NOTE);
    expect(result!.synthesises).toEqual([]);
  });

  it('returns null for non-note text', () => {
    expect(parseNoteFrontmatter('no frontmatter here')).toBeNull();
  });

  const SYN_NOTE = `---
id: SYN-2026-04-18-agent-memory-three-problems
created: 2026-04-18
keywords: [agent-memory, synthesis]
tags: [memory-systems, synthesis]
links: []
supersedes: null
synthesises: [MEM-2026-04-01-memory-decay, MEM-2026-04-02-retrieval-failure]
---

Synthesis body here.
`;

  it('parses SYN note id', () => {
    const result = parseNoteFrontmatter(SYN_NOTE);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('SYN-2026-04-18-agent-memory-three-problems');
  });

  it('parses synthesises list from SYN note', () => {
    const result = parseNoteFrontmatter(SYN_NOTE);
    expect(result!.synthesises).toEqual([
      'MEM-2026-04-01-memory-decay',
      'MEM-2026-04-02-retrieval-failure',
    ]);
  });

  it('no synthesises ID starts with [', () => {
    const result = parseNoteFrontmatter(SYN_NOTE);
    for (const id of result!.synthesises) {
      expect(id).not.toMatch(/^\[/);
    }
  });

  it('parses synthesis tag in SYN note', () => {
    const result = parseNoteFrontmatter(SYN_NOTE);
    expect(result!.tags).toContain('synthesis');
  });
});

describe('orgInlineMarkup', () => {
  describe('timestamps', () => {
    it('wraps date-only timestamp', () => {
      const out = orgInlineMarkup('[2026-03-28 Sat]');
      expect(out).toContain('class="org-date"');
      expect(out).toContain('[2026-03-28 Sat]');
    });

    it('wraps datetime timestamp', () => {
      const out = orgInlineMarkup('[2026-03-28 Sat 18:21]');
      expect(out).toContain('class="org-date"');
      expect(out).toContain('[2026-03-28 Sat 18:21]');
    });

    it('does not wrap non-timestamp bracketed text', () => {
      const out = orgInlineMarkup('[not a date]');
      expect(out).not.toContain('org-date');
    });
  });

  describe('bare URLs', () => {
    it('wraps a bare https URL as an external link', () => {
      const out = orgInlineMarkup('see https://example.com for details');
      expect(out).toContain('<a href="https://example.com"');
      expect(out).toContain('class="org-ext-link"');
      expect(out).toContain('target="_blank"');
    });

    it('wraps a bare http URL', () => {
      const out = orgInlineMarkup('http://example.com');
      expect(out).toContain('class="org-ext-link"');
    });

    it('does not double-wrap a URL already inside a [[...][...]] link', () => {
      const out = orgInlineMarkup('[[https://example.com][a link]]');
      // exactly one <a> tag
      expect(out.match(/<a /g)?.length).toBe(1);
      expect(out).not.toContain('org-ext-link');
    });
  });

  describe('id: links', () => {
    const idIndex = {
      '20260311T200527.770720': '#groups/main/files/extra/org/journal.org',
    };

    it('renders resolved id: link as <a> with org-id-link class', () => {
      const out = orgInlineMarkup(
        '[[id:20260311T200527.770720][nanoclaw-journal]]',
        idIndex,
      );
      expect(out).toContain(
        '<a href="#groups/main/files/extra/org/journal.org"',
      );
      expect(out).toContain('class="org-id-link"');
      expect(out).toContain('nanoclaw-journal');
      expect(out).not.toContain('target="_blank"');
    });

    it('renders unresolved id: link as <span> with tooltip', () => {
      const out = orgInlineMarkup('[[id:UNKNOWN][some note]]', idIndex);
      expect(out).toContain('<span class="org-id-link"');
      expect(out).toContain('title="id:UNKNOWN"');
      expect(out).toContain('some note');
    });

    it('renders id: link as span when no idIndex provided', () => {
      const out = orgInlineMarkup(
        '[[id:20260311T200527.770720][nanoclaw-journal]]',
      );
      expect(out).toContain('<span class="org-id-link"');
      expect(out).not.toContain('<a ');
    });
  });

  describe('regular [[...][...]] links', () => {
    it('renders https link as external <a>', () => {
      const out = orgInlineMarkup('[[https://example.com][visit]]');
      expect(out).toContain(
        '<a href="https://example.com" target="_blank">visit</a>',
      );
    });

    it('renders bare [[url]] link', () => {
      const out = orgInlineMarkup('[[https://example.com]]');
      expect(out).toContain(
        '<a href="https://example.com" target="_blank">https://example.com</a>',
      );
    });
  });

  describe('HTML escaping', () => {
    it('escapes < > & " in plain text', () => {
      const out = orgInlineMarkup('a < b & "c"');
      expect(out).toContain('&lt;');
      expect(out).toContain('&amp;');
      expect(out).toContain('&quot;');
    });
  });
});
