export class EmbeddingRateLimitError extends Error {
  readonly quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown';
  readonly retryDelayMs: number | null;

  constructor(message: string, quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown', retryDelayMs: number | null) {
    super(message);
    this.name = 'EmbeddingRateLimitError';
    this.quotaType = quotaType;
    this.retryDelayMs = retryDelayMs;
  }
}

export function isEmbeddingRateLimitError(err: unknown): err is EmbeddingRateLimitError {
  return err instanceof EmbeddingRateLimitError;
}
