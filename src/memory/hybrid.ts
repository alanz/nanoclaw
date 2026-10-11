export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '')}"`).join(' AND ');
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  textScore: number;
};

export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
}> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: string;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet) existing.snippet = r.snippet;
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  return Array.from(byId.values())
    .map((entry) => ({
      id: entry.id,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score: params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore,
      snippet: entry.snippet,
      source: entry.source,
    }))
    .sort((a, b) => b.score - a.score);
}

export interface SearchLocation {
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface FileSearchResult {
  path: string;
  source: string;
  /** The best of its locations' scores. */
  score: number;
  /** Best first, at most `locationsPerFile`. */
  locations: SearchLocation[];
  /** Matching locations left out by the cap. */
  moreLocations: number;
}

/**
 * Group ranked chunks into one result per file (specs/memory.allium,
 * MemorySearched): files rank by their best chunk and `limit` counts files.
 * Chunks whose line ranges overlap — adjacent chunks overlap by design — merge
 * into one location keeping the better score and its snippet. The best
 * location keeps its snippet whole; the others are cut to `otherSnippetChars`.
 *
 * The container's keyword fallback restates this (mcp-tools/memory.ts): host
 * and container share no modules.
 */
export function groupByFile(
  chunks: ReadonlyArray<{
    path: string;
    source: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
  }>,
  opts: { limit: number; locationsPerFile: number; otherSnippetChars: number },
): FileSearchResult[] {
  const byPath = new Map<string, { source: string; chunks: SearchLocation[] }>();
  for (const c of chunks) {
    const entry = byPath.get(c.path) ?? { source: c.source, chunks: [] };
    entry.chunks.push({ startLine: c.startLine, endLine: c.endLine, score: c.score, snippet: c.snippet });
    byPath.set(c.path, entry);
  }

  const files: FileSearchResult[] = [];
  for (const [path, entry] of byPath) {
    const byLine = [...entry.chunks].sort((a, b) => a.startLine - b.startLine);
    const merged: SearchLocation[] = [];
    for (const c of byLine) {
      const last = merged[merged.length - 1];
      if (last && c.startLine <= last.endLine) {
        last.endLine = Math.max(last.endLine, c.endLine);
        if (c.score > last.score) {
          last.score = c.score;
          last.snippet = c.snippet;
        }
      } else {
        merged.push({ ...c });
      }
    }
    merged.sort((a, b) => b.score - a.score);
    const locations = merged.slice(0, opts.locationsPerFile).map((l, i) => ({
      ...l,
      snippet: i === 0 ? l.snippet : l.snippet.slice(0, opts.otherSnippetChars),
    }));
    files.push({
      path,
      source: entry.source,
      score: locations[0]!.score,
      locations,
      moreLocations: merged.length - locations.length,
    });
  }

  return files.sort((a, b) => b.score - a.score).slice(0, opts.limit);
}
