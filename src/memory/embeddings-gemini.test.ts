import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  normalizeGeminiModel,
  parseGemini429,
} from './embeddings-gemini.js';

const createGeminiFetchMock = (embeddingValues = [1, 2, 3]) =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ embedding: { values: embeddingValues } }),
    text: async () =>
      JSON.stringify({ embedding: { values: embeddingValues } }),
  }));

const createGeminiBatchFetchMock = (
  count: number,
  embeddingValues = [1, 2, 3],
) =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({
      embeddings: Array.from({ length: count }, () => ({
        values: embeddingValues,
      })),
    }),
    text: async () =>
      JSON.stringify({
        embeddings: Array.from({ length: count }, () => ({
          values: embeddingValues,
        })),
      }),
  }));

function readFirstFetchRequest(fetchMock: { mock: { calls: unknown[][] } }) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return { url, init: init as RequestInit | undefined };
}

function parseFetchBody(
  fetchMock: { mock: { calls: unknown[][] } },
  callIndex = 0,
) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
}

function magnitude(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
}

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

// ---------- parseGemini429 ----------

describe('parseGemini429', () => {
  it('should parse actual RPD quota exhaustion error with detailed structure', () => {
    const errorBody = JSON.stringify({
      error: {
        code: 429,
        message:
          'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/embed_content_free_tier_requests, limit: 1000, model: gemini-embedding-1.0\nPlease retry in 18.412144672s.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.Help',
            links: [
              {
                description: 'Learn more about Gemini API quotas',
                url: 'https://ai.google.dev/gemini-api/docs/rate-limits',
              },
            ],
          },
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                quotaMetric:
                  'generativelanguage.googleapis.com/embed_content_free_tier_requests',
                quotaId:
                  'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier',
                quotaDimensions: {
                  location: 'global',
                  model: 'gemini-embedding-1.0',
                },
                quotaValue: '1000',
              },
            ],
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '18s',
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe('rpd');
    expect(result.retryDelayMs).toBe(18000);
  });

  it('should parse RPM quota error', () => {
    const errorBody = JSON.stringify({
      error: {
        details: [
          {
            violations: [
              {
                quotaId: 'RequestsPerMinutePerUser',
              },
            ],
          },
          {
            retryDelay: '31s',
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe('rpm');
    expect(result.retryDelayMs).toBe(31000);
  });

  it('should parse TPM quota error (TokensPerMinute pattern)', () => {
    const errorBody = JSON.stringify({
      error: {
        details: [
          {
            violations: [
              {
                quotaId:
                  'EmbedContentTokensPerMinutePerUserPerProjectPerModel-FreeTier',
              },
            ],
          },
          {
            retryDelay: '60s',
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe('tpm');
    expect(result.retryDelayMs).toBe(60000);
  });

  it('should handle unknown quota type', () => {
    const errorBody = JSON.stringify({
      error: {
        details: [
          {
            violations: [
              {
                quotaId: 'SomeOtherQuotaType',
              },
            ],
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe('unknown');
    expect(result.retryDelayMs).toBe(null);
  });

  it('should handle malformed JSON gracefully', () => {
    const result = parseGemini429('not valid json');

    expect(result.quotaType).toBe('unknown');
    expect(result.retryDelayMs).toBe(null);
  });

  it('should handle missing details field', () => {
    const errorBody = JSON.stringify({
      error: {
        code: 429,
        message: 'Rate limit exceeded',
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe('unknown');
    expect(result.retryDelayMs).toBe(null);
  });

  it('should parse fractional retry delay', () => {
    const errorBody = JSON.stringify({
      error: {
        details: [
          {
            retryDelay: '18.412144672s',
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.retryDelayMs).toBe(18412);
  });
});

// ---------- normalizeGeminiModel ----------

describe('normalizeGeminiModel', () => {
  it('returns default model for empty string', () => {
    expect(normalizeGeminiModel('')).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
  });

  it('strips models/ prefix', () => {
    expect(normalizeGeminiModel('models/gemini-embedding-001')).toBe(
      'gemini-embedding-001',
    );
  });

  it('strips gemini/ prefix', () => {
    expect(normalizeGeminiModel('gemini/gemini-embedding-001')).toBe(
      'gemini-embedding-001',
    );
  });

  it('strips google/ prefix', () => {
    expect(normalizeGeminiModel('google/gemini-embedding-001')).toBe(
      'gemini-embedding-001',
    );
  });

  it('returns model as-is when no prefix', () => {
    expect(normalizeGeminiModel('gemini-embedding-001')).toBe(
      'gemini-embedding-001',
    );
  });
});

// ---------- createGeminiEmbeddingProvider ----------

describe('createGeminiEmbeddingProvider', () => {
  it('defaults to gemini-embedding-001 when model is empty', () => {
    const { provider, client } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: '',
    });

    expect(client.model).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
    expect(provider.model).toBe(DEFAULT_GEMINI_EMBEDDING_MODEL);
  });

  it('uses correct endpoint URL for embedQuery', async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini-embedding-001',
    });

    await provider.embedQuery('test query');

    const { url } = readFirstFetchRequest(fetchMock);
    expect(url).toContain('https://generativelanguage.googleapis.com/v1beta');
    expect(url).toContain('gemini-embedding-001');
    expect(url).toContain('embedContent');
  });

  it('sends RETRIEVAL_QUERY taskType for embedQuery', async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini-embedding-001',
    });

    await provider.embedQuery('test query');

    const body = parseFetchBody(fetchMock);
    expect(body.taskType).toBe('RETRIEVAL_QUERY');
    expect(body.content).toEqual({ parts: [{ text: 'test query' }] });
  });

  it('sends RETRIEVAL_DOCUMENT taskType for embedBatch', async () => {
    const fetchMock = createGeminiBatchFetchMock(2);
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini-embedding-001',
    });

    await provider.embedBatch(['text1', 'text2']);

    const body = parseFetchBody(fetchMock);
    const requests = body.requests as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.taskType).toBe('RETRIEVAL_DOCUMENT');
    expect(requests[1]?.taskType).toBe('RETRIEVAL_DOCUMENT');
  });

  it('normalizes embedQuery response vectors', async () => {
    const fetchMock = createGeminiFetchMock([3, 4]);
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini-embedding-001',
    });

    const embedding = await provider.embedQuery('test query');

    expect(embedding[0]).toBeCloseTo(0.6, 5);
    expect(embedding[1]).toBeCloseTo(0.8, 5);
    expect(magnitude(embedding)).toBeCloseTo(1, 5);
  });

  it('normalizes embedBatch response vectors', async () => {
    const fetchMock = createGeminiBatchFetchMock(2, [3, 4]);
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini-embedding-001',
    });

    const embeddings = await provider.embedBatch(['text1', 'text2']);

    expect(embeddings).toHaveLength(2);
    for (const embedding of embeddings) {
      expect(embedding[0]).toBeCloseTo(0.6, 5);
      expect(embedding[1]).toBeCloseTo(0.8, 5);
      expect(magnitude(embedding)).toBeCloseTo(1, 5);
    }
  });

  it('returns empty array for blank query text', async () => {
    const { provider } = createGeminiEmbeddingProvider({ apiKey: 'test-key' });

    const result = await provider.embedQuery('   ');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty batch', async () => {
    const { provider } = createGeminiEmbeddingProvider({ apiKey: 'test-key' });

    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
  });

  it('sanitizes NaN values before normalization', async () => {
    const fetchMock = createGeminiFetchMock([3, 4, Number.NaN]);
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini-embedding-001',
    });

    await expect(provider.embedQuery('test')).resolves.toEqual([0.6, 0.8, 0]);
  });

  it('sanitizes non-finite values before normalization', async () => {
    const fetchMock = createGeminiFetchMock([
      1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini-embedding-001',
    });

    const embedding = await provider.embedQuery('test');

    expect(embedding).toEqual([1, 0, 0, 0]);
  });

  it('handles models/ prefix in model string', async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'models/gemini-embedding-001',
    });

    await provider.embedQuery('test');

    expect(provider.model).toBe('gemini-embedding-001');
  });

  it('handles gemini/ prefix in model string', async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const { provider } = createGeminiEmbeddingProvider({
      apiKey: 'test-key',
      model: 'gemini/gemini-embedding-001',
    });

    await provider.embedQuery('test');

    expect(provider.model).toBe('gemini-embedding-001');
  });
});
