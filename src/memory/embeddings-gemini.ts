import { sanitizeAndNormalizeEmbedding } from './embedding-vectors.js';
import { EmbeddingRateLimitError } from './embedding-errors.js';

export type GeminiTaskType =
  | 'RETRIEVAL_QUERY'
  | 'RETRIEVAL_DOCUMENT'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING';

const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

export type GeminiEmbeddingClient = {
  baseUrl: string;
  model: string;
  modelPath: string;
  apiKey: string;
};

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
  if (withoutPrefix.startsWith('gemini/'))
    return withoutPrefix.slice('gemini/'.length);
  if (withoutPrefix.startsWith('google/'))
    return withoutPrefix.slice('google/'.length);
  return withoutPrefix;
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

/**
 * Parse a Gemini 429 response body to extract quota type and retry delay.
 */
export function parseGemini429(payload: string): {
  quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown';
  retryDelayMs: number | null;
} {
  let quotaType: 'rpm' | 'rpd' | 'tpm' | 'unknown' = 'unknown';
  let retryDelayMs: number | null = null;

  try {
    const body = JSON.parse(payload) as {
      error?: {
        details?: Array<{
          violations?: Array<{ quotaId?: string }>;
          retryDelay?: string;
        }>;
      };
    };

    const details = body?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (Array.isArray(detail.violations)) {
          for (const v of detail.violations) {
            const qid = v.quotaId ?? '';
            if (/PerDay/i.test(qid)) {
              quotaType = 'rpd';
            } else if (/token.*PerMinute|PerMinute.*token/i.test(qid)) {
              quotaType = 'tpm';
            } else if (/PerMinute/i.test(qid)) {
              quotaType = 'rpm';
            }
          }
        }
        if (typeof detail.retryDelay === 'string') {
          const match = detail.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
          if (match) {
            retryDelayMs = Math.round(parseFloat(match[1]) * 1000);
          }
        }
      }
    }
  } catch {
    // leave defaults
  }

  return { quotaType, retryDelayMs };
}

async function postGemini(
  url: string,
  apiKey: string,
  body: unknown,
): Promise<{
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
}> {
  const res = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      const { quotaType, retryDelayMs } = parseGemini429(text);
      throw new EmbeddingRateLimitError(
        `Gemini embeddings 429: ${text.slice(0, 200)}`,
        quotaType,
        retryDelayMs,
      );
    }
    throw new Error(
      `Gemini embeddings failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }

  return (await res.json()) as {
    embedding?: { values?: number[] };
    embeddings?: Array<{ values?: number[] }>;
  };
}

/**
 * Create a simple Gemini embedding provider using a single API key and raw HTTP fetch.
 */
export function createGeminiEmbeddingProvider(params: {
  apiKey: string;
  model?: string;
}): { provider: EmbeddingProvider; client: GeminiEmbeddingClient } {
  const model = normalizeGeminiModel(
    params.model ?? DEFAULT_GEMINI_EMBEDDING_MODEL,
  );
  const modelPath = buildGeminiModelPath(model);
  const baseUrl = DEFAULT_GEMINI_BASE_URL;
  const embedUrl = `${baseUrl}/${modelPath}:embedContent`;
  const batchUrl = `${baseUrl}/${modelPath}:batchEmbedContents`;
  const { apiKey } = params;

  const client: GeminiEmbeddingClient = { baseUrl, model, modelPath, apiKey };

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) return [];
    const payload = await postGemini(embedUrl, apiKey, {
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY' satisfies GeminiTaskType,
    });
    return sanitizeAndNormalizeEmbedding(payload.embedding?.values ?? []);
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const payload = await postGemini(batchUrl, apiKey, {
      requests: texts.map((text) => ({
        model: modelPath,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT' satisfies GeminiTaskType,
      })),
    });
    const embeddings = Array.isArray(payload.embeddings)
      ? payload.embeddings
      : [];
    return texts.map((_, i) =>
      sanitizeAndNormalizeEmbedding(embeddings[i]?.values ?? []),
    );
  };

  return {
    provider: { id: 'gemini', model, embedQuery, embedBatch },
    client,
  };
}
