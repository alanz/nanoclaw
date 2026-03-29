/**
 * In-memory usage counters — reset on process restart.
 * Incremented by the credential proxy and embedding client.
 */
export const stats = {
  startTime: Date.now(),
  proxyRequests: 0, // total requests through credential proxy
  claudeRequests: 0, // /v1/messages calls (Claude completions)
  geminiEmbeds: 0, // Gemini embedding API calls
};
