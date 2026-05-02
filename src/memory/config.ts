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

// Widened type so tests can pass { memory_search_enabled: false } without a literal mismatch.
export type MemoryConfig = {
  chunk_tokens: number;
  chunk_overlap_tokens: number;
  search_top_k: number;
  min_search_score: number;
  vector_score_weight: number;
  keyword_score_weight: number;
  embedding_provider: string;
  embedding_rpm_limit: number;
  embedding_tpm_limit: number;
  embedding_rpd_budget: number;
  memory_search_enabled: boolean;
};
