import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ABSTRACT,
  MAX_ABSTRACT,
  parseFrontMatter,
  insertAbstract,
  addFrontMatterField,
  validateAbstract,
} from './zotero-frontmatter.mjs';

const FM = `---
title: Test Paper
doi: 10.1234/test
---
`;
const FM_WITH_BODY = `---
title: Test Paper
---
Some body text here.
`;

// ── parseFrontMatter ──────────────────────────────────────────────────────────

describe('parseFrontMatter', () => {
  it('returns null when no frontmatter block is present', () => {
    assert.equal(parseFrontMatter('Just plain text\nno frontmatter'), null);
  });

  it('returns null when opening --- has no closing ---', () => {
    assert.equal(parseFrontMatter('---\ntitle: Test\n'), null);
  });

  it('parses key-value pairs into meta', () => {
    const result = parseFrontMatter(FM);
    assert.deepEqual(result?.meta, { title: 'Test Paper', doi: '10.1234/test' });
  });

  it('returns the body after the closing ---', () => {
    const result = parseFrontMatter(FM_WITH_BODY);
    assert.equal(result?.body, 'Some body text here.\n');
  });

  it('returns empty body when nothing follows the frontmatter', () => {
    const result = parseFrontMatter(FM);
    assert.equal(result?.body, '');
  });
});

// ── insertAbstract ────────────────────────────────────────────────────────────

describe('insertAbstract', () => {
  it('appends the abstract separated by a blank line', () => {
    const result = insertAbstract(FM, 'This is the abstract.');
    assert.ok(result.endsWith('\n\nThis is the abstract.\n'));
  });

  it('trims trailing whitespace from the original text before appending', () => {
    const result = insertAbstract(FM + '   ', 'Abstract text.');
    assert.ok(!result.includes('   \n\n'));
  });

  it('trims leading/trailing whitespace from the abstract', () => {
    const result = insertAbstract(FM, '  Abstract text.  ');
    assert.ok(result.endsWith('\n\nAbstract text.\n'));
  });
});

// ── addFrontMatterField ───────────────────────────────────────────────────────

describe('addFrontMatterField', () => {
  it('inserts the field before the closing ---', () => {
    const result = addFrontMatterField(FM, 'abstract_source', 's2_doi');
    assert.ok(result.includes('\nabstract_source: s2_doi\n---'));
  });

  it('does not disturb existing fields', () => {
    const result = addFrontMatterField(FM, 'abstract_source', 'cr_title');
    assert.ok(result.includes('title: Test Paper'));
    assert.ok(result.includes('doi: 10.1234/test'));
  });

  it('returns the text unchanged when there is no frontmatter', () => {
    const plain = 'No frontmatter here.';
    assert.equal(addFrontMatterField(plain, 'k', 'v'), plain);
  });

  it('returns the text unchanged when the opening --- has no closing ---', () => {
    const broken = '---\ntitle: Test\n';
    assert.equal(addFrontMatterField(broken, 'k', 'v'), broken);
  });
});

// ── validateAbstract ──────────────────────────────────────────────────────────

describe('validateAbstract', () => {
  it('returns null for null input', () => {
    assert.equal(validateAbstract(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(validateAbstract(''), null);
  });

  it(`returns null for text shorter than ${MIN_ABSTRACT} chars`, () => {
    assert.equal(validateAbstract('a'.repeat(MIN_ABSTRACT - 1)), null);
  });

  it(`accepts text at exactly ${MIN_ABSTRACT} chars`, () => {
    const text = 'a'.repeat(MIN_ABSTRACT);
    assert.equal(validateAbstract(text), text);
  });

  it('passes through text within bounds unchanged', () => {
    const text = 'a'.repeat(500);
    assert.equal(validateAbstract(text), text);
  });

  it(`truncates text longer than ${MAX_ABSTRACT} chars and appends ellipsis`, () => {
    const text = 'a'.repeat(MAX_ABSTRACT + 100);
    const result = validateAbstract(text);
    assert.ok(result !== null);
    assert.ok(result.endsWith('…'));
    assert.ok(result.length <= MAX_ABSTRACT + 1); // +1 for the ellipsis char
  });

  it('truncates at a word boundary, not mid-word', () => {
    // Build a string of exactly MAX_ABSTRACT+1 chars that ends with a full word
    const word = 'overflow';
    const padding = 'x '.repeat(Math.floor((MAX_ABSTRACT - word.length) / 2));
    const text = (padding + word + ' ').slice(0, MAX_ABSTRACT + 50);
    const result = validateAbstract(text);
    assert.ok(result !== null);
    assert.ok(!result.slice(0, -1).endsWith(' ')); // no trailing space before ellipsis
  });
});
