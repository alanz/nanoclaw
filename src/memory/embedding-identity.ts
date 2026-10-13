/**
 * Which embedding endpoint and model produced a vector — apart from the
 * provider client so code and tests that replace the client keep it.
 */
import crypto from 'node:crypto';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Vector size of gemini-embedding-001 at its default output dimensionality. */
export const GEMINI_EMBEDDING_DIMS = 3072;

/**
 * Identifies the embedding endpoint and model, so embeddings from a different
 * one are never mixed in: part of the embedding cache key and of the index
 * fingerprint. Holds no credential.
 */
export function geminiProviderKey(model: string): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ provider: 'gemini', baseUrl: GEMINI_BASE_URL, model }))
    .digest('hex')
    .slice(0, 32);
}

/**
 * A vector the index can store: the expected size, every value finite, not
 * all zeros. Anything else is refused rather than written or cached — a short
 * or empty vector would be stored as a valid embedding and never retried.
 */
export function isUsableEmbedding(vec: unknown, dims: number): vec is number[] {
  if (!Array.isArray(vec) || vec.length !== dims) return false;
  let magnitude = 0;
  for (const v of vec) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    magnitude += v * v;
  }
  return magnitude > 0;
}
