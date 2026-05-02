export const MEMORY_CONFIG = {
  chunk_tokens: 400,
  chunk_overlap_tokens: 80,
  search_top_k: 6,
  min_search_score: 0.35,
  vector_score_weight: 0.7,
  keyword_score_weight: 0.3,
  embedding_provider: 'gemini',
  embedding_rpm_limit: 50,
  embedding_tpm_limit: 15_000,
  embedding_rpd_budget: 900,
  memory_search_enabled: true,
} as const;

export type MemoryConfig = typeof MEMORY_CONFIG;
