/**
 * Shared pure helpers for reading and writing Zotero markdown frontmatter.
 * Used by zotero-enrich.mjs and zotero-extract-abstracts.mjs.
 */

export const MIN_ABSTRACT = 80;
export const MAX_ABSTRACT = 3000;

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Returns { meta, body } or null if no frontmatter block is present.
 */
export function parseFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const end = text.indexOf('\n---', nl + 1);
  if (end < 0) return null;
  const fmText = text.slice(nl + 1, end);
  const bodyStart = end + 4 + (text[end + 4] === '\n' ? 1 : 0);
  const meta = {};
  for (const line of fmText.split('\n')) {
    const colon = line.indexOf(': ');
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 2).trim();
  }
  return { meta, body: text.slice(bodyStart) };
}

/**
 * Append an abstract to the end of a markdown file's content.
 */
export function insertAbstract(text, abstract) {
  return text.trimEnd() + '\n\n' + abstract.trim() + '\n';
}

/**
 * Insert a key: value line into the frontmatter block.
 * Returns the original text unchanged if no frontmatter is present.
 */
export function addFrontMatterField(text, key, value) {
  if (!text.startsWith('---')) return text;
  const nl = text.indexOf('\n');
  if (nl < 0) return text;
  const end = text.indexOf('\n---', nl + 1);
  if (end < 0) return text;
  return text.slice(0, end) + `\n${key}: ${value}` + text.slice(end);
}

/**
 * Validate abstract length against configured bounds.
 * Returns null if too short, truncates at a word boundary if too long.
 */
export function validateAbstract(text) {
  if (!text || text.length < MIN_ABSTRACT) return null;
  if (text.length > MAX_ABSTRACT) return text.slice(0, MAX_ABSTRACT).replace(/ \S+$/, '') + '…';
  return text;
}
