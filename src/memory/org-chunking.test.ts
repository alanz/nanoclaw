import { describe, expect, it } from 'vitest';
import { chunkOrgMode, parseOrgStructure } from './org-chunking.js';

// NanoClaw's org-chunking does not export mergeContentElements, so we only test
// parseOrgStructure and chunkOrgMode.

describe('parseOrgStructure', () => {
  it('detects top-level headings', () => {
    const content = '* Heading 1\n** Heading 2\n*** Heading 3';
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(3);
    expect(elements[0]).toMatchObject({
      type: 'heading',
      level: 1,
      startLine: 1,
      text: '* Heading 1',
    });
    expect(elements[1]).toMatchObject({
      type: 'heading',
      level: 2,
      startLine: 2,
      text: '** Heading 2',
    });
    expect(elements[2]).toMatchObject({
      type: 'heading',
      level: 3,
      startLine: 3,
      text: '*** Heading 3',
    });
  });

  it('detects headings with TODO keywords and tags', () => {
    const content = '* TODO [#A] Important task :work:urgent:';
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      type: 'heading',
      level: 1,
      text: '* TODO [#A] Important task :work:urgent:',
    });
  });

  it('detects property drawers', () => {
    const content = `* Heading
:PROPERTIES:
:ID: abc-123
:CREATED: [2026-02-15]
:END:`;
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(2);
    expect(elements[0]?.type).toBe('heading');
    expect(elements[1]).toMatchObject({
      type: 'property-drawer',
      startLine: 2,
      endLine: 5,
    });
    expect(elements[1]?.text).toContain(':PROPERTIES:');
    expect(elements[1]?.text).toContain(':ID: abc-123');
    expect(elements[1]?.text).toContain(':END:');
  });

  it('detects source code blocks', () => {
    const content = `#+BEGIN_SRC python
def hello():
    print("Hello, World!")
#+END_SRC`;
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      type: 'block',
      startLine: 1,
      endLine: 4,
    });
    expect(elements[0]?.text).toContain('def hello()');
  });

  it('detects quote blocks', () => {
    const content = `#+BEGIN_QUOTE
This is a famous quote.
- Someone Important
#+END_QUOTE`;
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      type: 'block',
      startLine: 1,
      endLine: 4,
    });
  });

  it('detects example blocks', () => {
    const content = `#+BEGIN_EXAMPLE
Example output here
#+END_EXAMPLE`;
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(1);
    expect(elements[0]?.type).toBe('block');
  });

  it('detects general drawers', () => {
    const content = `:LOGBOOK:
- Note taken on [2026-02-15 Sat 10:00]
:END:`;
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      type: 'drawer',
      startLine: 1,
      endLine: 3,
    });
  });

  it('treats regular text as content', () => {
    const content = 'This is regular text.\nAnother line.';
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(2);
    expect(elements[0]?.type).toBe('content');
    expect(elements[1]?.type).toBe('content');
  });

  it('handles complex mixed content', () => {
    const content = `* Project Notes
:PROPERTIES:
:ID: project-123
:END:

Some introduction text.

** TODO First Task
- [ ] Item 1
- [ ] Item 2

#+BEGIN_SRC bash
npm install
#+END_SRC

** DONE Second Task
Task completed.`;

    const elements = parseOrgStructure(content);

    expect(elements.length).toBeGreaterThan(5);
    expect(elements.filter((e) => e.type === 'heading')).toHaveLength(3);
    expect(elements.filter((e) => e.type === 'property-drawer')).toHaveLength(
      1,
    );
    expect(elements.filter((e) => e.type === 'block')).toHaveLength(1);
  });

  it('handles blocks with case-insensitive matching', () => {
    const content = `#+begin_src python
print("hello")
#+end_src`;
    const elements = parseOrgStructure(content);

    expect(elements).toHaveLength(1);
    expect(elements[0]?.type).toBe('block');
  });
});

describe('chunkOrgMode', () => {
  it('creates single chunk for small content', () => {
    const content = '* Heading\nSome text.';
    const chunks = chunkOrgMode(content, { tokens: 400, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('* Heading');
    expect(chunks[0]?.text).toContain('Some text.');
  });

  it('splits large content at heading boundaries', () => {
    const content = `* First Section
${'x'.repeat(2000)}

* Second Section
${'y'.repeat(2000)}`;

    const chunks = chunkOrgMode(content, { tokens: 400, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.text).toContain('First Section');
    expect(chunks[chunks.length - 1]?.text).toContain('Second Section');
  });

  it('includes parent heading context in child chunks', () => {
    const content = `* Parent Heading

** Child Heading
${'Content '.repeat(500)}`;

    const chunks = chunkOrgMode(content, { tokens: 200, overlap: 0 });

    // Child section chunks should include parent heading context
    const childChunks = chunks.filter((c) => c.text.includes('Child Heading'));
    expect(childChunks.length).toBeGreaterThan(0);
    expect(childChunks[0]?.text).toContain('* Parent Heading');
  });

  it('never splits blocks across chunks', () => {
    const largeBlock = `#+BEGIN_SRC python
${'# Code line\n'.repeat(200)}
#+END_SRC`;

    const content = `* Heading
Text before.

${largeBlock}

Text after.`;

    const chunks = chunkOrgMode(content, { tokens: 100, overlap: 0 });

    // The block should be entirely in one chunk
    const blockChunks = chunks.filter((c) => c.text.includes('#+BEGIN_SRC'));
    expect(blockChunks).toHaveLength(1);
    expect(blockChunks[0]?.text).toContain('#+END_SRC');
  });

  it('never splits property drawers across chunks', () => {
    const content = `* Heading 1
:PROPERTIES:
:ID: abc-123
:CUSTOM: value
:END:

* Heading 2
More content here.`;

    const chunks = chunkOrgMode(content, { tokens: 50, overlap: 0 });

    // Property drawer should be in one chunk with its heading
    const propChunks = chunks.filter((c) => c.text.includes(':PROPERTIES:'));
    expect(propChunks).toHaveLength(1);
    expect(propChunks[0]?.text).toContain(':END:');
  });

  it('handles nested headings correctly', () => {
    const content = `* Level 1
Content 1

** Level 2A
Content 2A

*** Level 3
Content 3

** Level 2B
Content 2B`;

    const chunks = chunkOrgMode(content, { tokens: 50, overlap: 0 });

    // Level 3 chunks should include both parent headings
    const level3Chunks = chunks.filter((c) => c.text.includes('*** Level 3'));
    if (level3Chunks.length > 0) {
      expect(level3Chunks[0]?.text).toContain('* Level 1');
      expect(level3Chunks[0]?.text).toContain('** Level 2A');
    }
  });

  it('preserves line numbers correctly', () => {
    const content = `* Heading 1
Line 2
Line 3

* Heading 2
Line 6`;

    const chunks = chunkOrgMode(content, { tokens: 400, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.startLine).toBe(1);
    if (chunks.length > 1) {
      expect(chunks[1]?.startLine).toBeGreaterThan(chunks[0]?.endLine ?? 0);
    }
  });

  it('handles empty lines gracefully', () => {
    const content = `* Heading


Content with blank lines



More content`;

    const chunks = chunkOrgMode(content, { tokens: 400, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.text).toContain('* Heading');
  });

  it('handles documents without headings', () => {
    const content = `Regular text content.
No headings here.
Just plain text.`;

    const chunks = chunkOrgMode(content, { tokens: 400, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('Regular text');
  });

  it('handles very large blocks gracefully', () => {
    // Block larger than max chunk size should still be kept intact
    const hugeBlock = `#+BEGIN_SRC python
${'# Very long code\n'.repeat(1000)}
#+END_SRC`;

    const chunks = chunkOrgMode(hugeBlock, { tokens: 100, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('#+BEGIN_SRC');
    expect(chunks[0]?.text).toContain('#+END_SRC');
  });

  it('real-world example: research notes', () => {
    const content = `* Research Notes
:PROPERTIES:
:CREATED: [2026-02-15]
:TAGS: research, ai, memory
:END:

This document contains research notes on memory systems.

** Background
*** Historical Context

Memory systems have evolved significantly over the past decade.

#+BEGIN_QUOTE
"Memory is the key to intelligence"
- Famous Researcher
#+END_QUOTE

*** Current State

Modern systems use vector embeddings and semantic search.

** Implementation
*** Architecture

The system consists of:
1. Embedding generator
2. Vector store
3. Retrieval mechanism

#+BEGIN_SRC python
def generate_embedding(text):
    # Implementation here
    return embeddings
#+END_SRC

*** Performance Considerations

- Latency: <100ms
- Throughput: 1000 queries/sec
- Storage: Efficient compression

** Future Work

:LOGBOOK:
- Note taken on [2026-02-15]
:END:

Need to investigate:
- Better chunking strategies
- Multi-modal embeddings
- Real-time updates`;

    const chunks = chunkOrgMode(content, { tokens: 200, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);

    // Verify structure is preserved
    const hasProperties = chunks.some((c) => c.text.includes(':PROPERTIES:'));
    const hasQuote = chunks.some((c) => c.text.includes('#+BEGIN_QUOTE'));
    const hasCode = chunks.some((c) => c.text.includes('#+BEGIN_SRC'));
    const hasLogbook = chunks.some((c) => c.text.includes(':LOGBOOK:'));

    expect(hasProperties).toBe(true);
    expect(hasQuote).toBe(true);
    expect(hasCode).toBe(true);
    expect(hasLogbook).toBe(true);

    // Verify no chunks split blocks
    for (const chunk of chunks) {
      const hasBeginQuote = chunk.text.includes('#+BEGIN_QUOTE');
      const hasEndQuote = chunk.text.includes('#+END_QUOTE');
      if (hasBeginQuote || hasEndQuote) {
        expect(hasBeginQuote).toBe(hasEndQuote);
      }

      const hasBeginSrc = chunk.text.includes('#+BEGIN_SRC');
      const hasEndSrc = chunk.text.includes('#+END_SRC');
      if (hasBeginSrc || hasEndSrc) {
        expect(hasBeginSrc).toBe(hasEndSrc);
      }
    }
  });
});
