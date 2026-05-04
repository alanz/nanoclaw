/**
 * Web search MCP tool: brave_web_search.
 *
 * Only registered when BRAVE_API_KEY is present in the container environment.
 * The host injects this from .env via container-runner.ts.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

if (BRAVE_API_KEY) {
  const braveWebSearch: McpToolDefinition = {
    tool: {
      name: 'brave_web_search',
      description:
        'Search the web using Brave Search API. Use for current events, factual lookups, news, and general web research.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (max 400 chars)' },
          count: {
            type: 'number',
            description: 'Number of results (1-20, default 10)',
            minimum: 1,
            maximum: 20,
            default: 10,
          },
          country: {
            type: 'string',
            description: 'Country code to localise results (e.g. "us", "gb")',
          },
          freshness: {
            type: 'string',
            description:
              'Filter by age: "pd" past day, "pw" past week, "pm" past month, "py" past year, or date range "YYYY-MM-DDtoYYYY-MM-DD"',
          },
        },
        required: ['query'],
      },
    },
    async handler(args) {
      const query = args.query as string;
      const count = (args.count as number | undefined) ?? 10;
      const country = args.country as string | undefined;
      const freshness = args.freshness as string | undefined;

      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));
      if (country) url.searchParams.set('country', country);
      if (freshness) url.searchParams.set('freshness', freshness);

      try {
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': BRAVE_API_KEY as string,
          },
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Brave Search error (${res.status}): ${detail || res.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as {
          web?: {
            results?: Array<{
              title?: string;
              url?: string;
              description?: string;
              age?: string;
            }>;
          };
        };
        const results = data.web?.results ?? [];
        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title ?? ''}**\n   ${r.url ?? ''}\n   ${r.description ?? ''}${r.age ? ` (${r.age})` : ''}`,
          )
          .join('\n\n');

        return {
          content: [{ type: 'text' as const, text: formatted || 'No results found.' }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };

  registerTools([braveWebSearch]);
}
