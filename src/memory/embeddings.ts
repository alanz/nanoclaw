import { EmbeddingRateLimitError } from './embedding-errors.js';

export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

function sanitizeAndNormalize(vec: number[]): number[] {
  const sanitized = vec.map((v) => (Number.isFinite(v) ? v : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return sanitized;
  return sanitized.map((v) => v / magnitude);
}

async function postGemini(
  url: string,
  apiKey: string,
  body: unknown,
): Promise<{ embedding?: { values?: number[] }; embeddings?: Array<{ values?: number[] }> }> {
  const res = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      const { quotaType, retryDelayMs } = parseGemini429(text);
      throw new EmbeddingRateLimitError(`Gemini 429: ${text.slice(0, 200)}`, quotaType, retryDelayMs);
    }
    throw new Error(`Gemini embeddings failed: ${res.status} ${text.slice(0, 200)}`);
  }

  return (await res.json()) as {
    embedding?: { values?: number[] };
    embeddings?: Array<{ values?: number[] }>;
  };
}

export function createGeminiEmbeddingProvider(params: { apiKey: string; model?: string }): EmbeddingProvider {
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
      const payload = await postGemini(embedUrl, apiKey, {
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_QUERY',
      });
      return sanitizeAndNormalize(payload.embedding?.values ?? []);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const payload = await postGemini(batchUrl, apiKey, {
        requests: texts.map((text) => ({
          model: modelPath,
          content: { parts: [{ text }] },
          taskType: 'RETRIEVAL_DOCUMENT',
        })),
      });
      const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
      return texts.map((_, i) => sanitizeAndNormalize(embeddings[i]?.values ?? []));
    },
  };
}
