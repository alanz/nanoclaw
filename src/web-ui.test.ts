import { describe, expect, it } from 'vitest';

import { parseNoteFrontmatter } from './web-ui.js';

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

  it('returns null for non-note text', () => {
    expect(parseNoteFrontmatter('no frontmatter here')).toBeNull();
  });
});
