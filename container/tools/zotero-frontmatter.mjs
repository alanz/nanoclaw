/**
 * Shared pure helpers for reading and writing Zotero markdown frontmatter.
 * Used by zotero-enrich.mjs, zotero-extract-abstracts.mjs and zotero-abstracts.mjs.
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

/**
 * Set a frontmatter field, replacing an existing line for the key or adding one.
 */
export function setFrontMatterField(text, key, value) {
  const without = removeFrontMatterField(text, key);
  return addFrontMatterField(without, key, value);
}

/**
 * Remove every frontmatter line for the key. Body lines are never touched.
 */
export function removeFrontMatterField(text, key) {
  if (!text.startsWith('---')) return text;
  const nl = text.indexOf('\n');
  if (nl < 0) return text;
  const end = text.indexOf('\n---', nl + 1);
  if (end < 0) return text;
  const lines = text.slice(nl + 1, end).split('\n').filter((l) => !l.startsWith(`${key}: `));
  return text.slice(0, nl + 1) + lines.join('\n') + text.slice(end);
}

/** True when the body carries more than the heading and author/year line. */
export function hasAbstract(body) {
  return body.split('\n').filter((l) => l.trim()).length > 2;
}

// ── Lookup records (zotero.allium AbstractLookupRecorded) ─────────────────────

export const LOOKUP_FIELD = 'abstract_lookup';
export const RETRY_INTERVAL_DAYS = 180;

/** `abstract_lookup: <ISO timestamp> <not_found|inconclusive>` → { at, result }, or null. */
export function parseLookup(meta) {
  const m = (meta?.[LOOKUP_FIELD] || '').match(/^(\S+)\s+(not_found|inconclusive)$/);
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { at: m[1], result: m[2] };
}

export function formatLookup(now, result) {
  return `${now.toISOString()} ${result}`;
}

/** Record a lookup that ended without an abstract. */
export function recordLookup(text, now, result) {
  return setFrontMatterField(text, LOOKUP_FIELD, formatLookup(now, result));
}

/** Insert a found abstract, recording its source and dropping any lookup record. */
export function applyAbstract(text, abstract, source) {
  const withSource = setFrontMatterField(removeFrontMatterField(text, LOOKUP_FIELD), 'abstract_source', source);
  return insertAbstract(withSource, abstract);
}

/**
 * In the enrichment backlog: no abstract, and not a not_found lookup younger
 * than the retry interval. Unparseable records count as no record.
 */
export function inBacklog(parsed, now, retryDays = RETRY_INTERVAL_DAYS) {
  if (!parsed || hasAbstract(parsed.body)) return false;
  const lookup = parseLookup(parsed.meta);
  if (!lookup || lookup.result !== 'not_found') return true;
  const age = now.getTime() - Date.parse(lookup.at);
  return age >= retryDays * 86_400_000;
}

function hasIdentifier(meta) {
  const url = meta.url || '';
  return !!meta.doi || /arxiv\.org\/(?:abs|pdf)\//i.test(url) || /(?:doi\.org\/|\/doi\/)10\.\d{4,}\//i.test(url);
}

/**
 * Backlog order: never looked up (items with a DOI or arXiv ID first), then
 * inconclusive, then expired not_found, each oldest lookup first. Entries are
 * { meta, ... }; ties keep input order.
 */
export function prioritiseBacklog(entries) {
  const tier = (e) => {
    const lookup = parseLookup(e.meta);
    return lookup === null ? 0 : lookup.result === 'inconclusive' ? 1 : 2;
  };
  return entries
    .map((e, i) => {
      const at = parseLookup(e.meta)?.at;
      return { e, i, tier: tier(e), at: at ? Date.parse(at) : 0, id: hasIdentifier(e.meta) ? 0 : 1 };
    })
    .sort((a, b) => a.tier - b.tier || a.at - b.at || a.id - b.id || a.i - b.i)
    .map((x) => x.e);
}
