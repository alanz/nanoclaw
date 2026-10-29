export const MEMORY_CONFIG = {
  chunk_tokens: 400,
  chunk_overlap_tokens: 80,
  search_top_k: 6,
  search_locations_per_file: 3,
  min_search_score: 0.35,
  // Keyword-only results are scored by keyword alone, so they need their own
  // floor: the container's fallback search and the tool description use 0.1.
  min_keyword_score: 0.1,
  search_embed_wait_ms: 3_000,
  vector_score_weight: 0.7,
  keyword_score_weight: 0.3,
  embedding_provider: 'gemini',
  embedding_rpm_limit: 50,
  embedding_tpm_limit: 15_000,
  embedding_rpd_budget: 900,
} as const;

// Widened type so tests can pass other values without a literal mismatch. There
// is no enable flag: memory is on exactly when an embedding key is configured
// (spec: embedding_key_configured), checked where the managers start.
export type MemoryConfig = {
  chunk_tokens: number;
  chunk_overlap_tokens: number;
  search_top_k: number;
  search_locations_per_file: number;
  min_search_score: number;
  min_keyword_score: number;
  search_embed_wait_ms: number;
  vector_score_weight: number;
  keyword_score_weight: number;
  embedding_provider: string;
  embedding_rpm_limit: number;
  embedding_tpm_limit: number;
  embedding_rpd_budget: number;
};
