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
