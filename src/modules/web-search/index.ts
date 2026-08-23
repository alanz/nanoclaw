/**
 * Web search (Brave) — host-side wiring.
 *
 * The `web_search` tool lives in the agent-runner
 * (`container/agent-runner/src/mcp-tools/search.ts`) and registers only when
 * BRAVE_API_KEY is in the container environment. This passes it through from
 * `.env` to every session — specialists included, since the Researcher is the
 * heaviest user.
 *
 * Disabled unless BRAVE_API_KEY is set.
 */
import { registerSessionContributor } from '../../container-runner.js';
import { readEnvFile } from '../../env.js';

registerSessionContributor(() => {
  const key = process.env.BRAVE_API_KEY || readEnvFile(['BRAVE_API_KEY']).BRAVE_API_KEY;
  return key ? { env: { BRAVE_API_KEY: key } } : undefined;
});
