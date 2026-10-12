import { EmbeddingRateLimitError } from './embedding-errors.js';
import { GEMINI_BASE_URL as BASE_URL } from './embedding-identity.js';

export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

export type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
};

export function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return DEFAULT_GEMINI_EMBEDDING_MODEL;
  const withoutPrefix = trimmed.replace(/^models\//, '');
  if (withoutPrefix.startsWith('gemini/')) return withoutPrefix.slice('gemini/'.length);
  if (withoutPrefix.startsWith('google/')) return withoutPrefix.slice('google/'.length);
  return withoutPrefix;
}

export function parseGemini429(payload: string): {
  quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown';
  retryDelayMs: number | null;
} {
  let quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown' = 'unknown';
  let retryDelayMs: number | null = null;
  try {
    const body = JSON.parse(payload) as {
      error?: { details?: Array<{ violations?: Array<{ quotaId?: string }>; retryDelay?: string }> };
    };
    for (const detail of body?.error?.details ?? []) {
      for (const v of detail.violations ?? []) {
        const qid = v.quotaId ?? '';
        if (/PerDay/i.test(qid)) quotaType = 'rpd';
        else if (/token.*PerMinute|PerMinute.*token/i.test(qid)) quotaType = 'tpm';
        else if (/PerMinute/i.test(qid)) quotaType = 'rpm';
      }
      if (typeof detail.retryDelay === 'string') {
        const match = detail.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
        if (match) retryDelayMs = Math.round(parseFloat(match[1]) * 1000);
      }
    }
  } catch {}
  return { quotaType, retryDelayMs };
}

/**
 * Normalise to unit length. A vector with a non-finite value is returned as
 * is, for the caller to refuse (isUsableEmbedding) — zeroing the bad values
 * would hide it.
 */
function normalize(vec: number[]): number[] {
  if (!vec.every((v) => Number.isFinite(v))) return vec;
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

/** How long a call may take, and how failures that may pass are retried. */
export type GeminiTiming = {
  queryTimeoutMs: number;
  batchTimeoutMs: number;
  /** Retries of a batch after a 5xx, a network error or a timeout. Queries are not retried. */
  batchRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
};

// A search must answer fast, falling back to keyword-only; indexing can wait.
const DEFAULT_TIMING: GeminiTiming = {
  queryTimeoutMs: 10_000,
  batchTimeoutMs: 120_000,
  batchRetries: 3,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 8_000,
};

/** A failure another attempt may not meet: a 5xx, the network, or a timeout. */
class TransientEmbeddingError extends Error {}

type GeminiPayload = { embedding?: { values?: number[] }; embeddings?: Array<{ values?: number[] }> };

async function postGeminiOnce(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<GeminiPayload> {
  let res: Response;
  try {
    res = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new TransientEmbeddingError(
      timedOut
        ? `Gemini embeddings timed out after ${timeoutMs} ms`
        : `Gemini embeddings request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      const { quotaType, retryDelayMs } = parseGemini429(text);
      throw new EmbeddingRateLimitError(`Gemini 429: ${text.slice(0, 200)}`, quotaType, retryDelayMs);
    }
    const message = `Gemini embeddings failed: ${res.status} ${text.slice(0, 200)}`;
    throw res.status >= 500 ? new TransientEmbeddingError(message) : new Error(message);
  }

  return (await res.json()) as GeminiPayload;
}

async function postGemini(
  url: string,
  apiKey: string,
  body: unknown,
  opts: { timeoutMs: number; retries: number; timing: GeminiTiming },
): Promise<GeminiPayload> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postGeminiOnce(url, apiKey, body, opts.timeoutMs);
    } catch (err) {
      if (!(err instanceof TransientEmbeddingError) || attempt >= opts.retries) throw err;
      const backoff = Math.min(opts.timing.retryBaseDelayMs * 2 ** attempt, opts.timing.retryMaxDelayMs);
      await new Promise((r) => setTimeout(r, backoff * (0.5 + Math.random() / 2)));
    }
  }
}

export function createGeminiEmbeddingProvider(params: {
  apiKey: string;
  model?: string;
  timing?: Partial<GeminiTiming>;
}): EmbeddingProvider {
  const timing = { ...DEFAULT_TIMING, ...params.timing };
  const model = normalizeGeminiModel(params.model ?? DEFAULT_GEMINI_EMBEDDING_MODEL);
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;
  const embedUrl = `${BASE_URL}/${modelPath}:embedContent`;
  const batchUrl = `${BASE_URL}/${modelPath}:batchEmbedContents`;
  const { apiKey } = params;

  return {
    id: 'gemini',
    model,

    async embedQuery(text: string): Promise<number[]> {
      if (!text.trim()) return [];
      const payload = await postGemini(
        embedUrl,
        apiKey,
        { content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY' },
        { timeoutMs: timing.queryTimeoutMs, retries: 0, timing },
      );
      return normalize(payload.embedding?.values ?? []);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const payload = await postGemini(
        batchUrl,
        apiKey,
        {
          requests: texts.map((text) => ({
            model: modelPath,
            content: { parts: [{ text }] },
            taskType: 'RETRIEVAL_DOCUMENT',
          })),
        },
        { timeoutMs: timing.batchTimeoutMs, retries: timing.batchRetries, timing },
      );
      const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
      return texts.map((_, i) => normalize(embeddings[i]?.values ?? []));
    },
  };
}
