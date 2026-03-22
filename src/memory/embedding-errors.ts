/**
 * Structured error for embedding API rate limit (429) responses.
 * Carries parsed quota type and retry delay so callers can make
 * targeted rate-limiter decisions instead of treating all 429s identically.
 */
export class EmbeddingRateLimitError extends Error {
  readonly quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown';
  readonly retryDelayMs: number | null;

  constructor(
    message: string,
    quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown',
    retryDelayMs: number | null,
  ) {
    super(message);
    this.name = 'EmbeddingRateLimitError';
    this.quotaType = quotaType;
    this.retryDelayMs = retryDelayMs;
  }
}

export function isEmbeddingRateLimitError(
  err: unknown,
): err is EmbeddingRateLimitError {
  return err instanceof EmbeddingRateLimitError;
}
