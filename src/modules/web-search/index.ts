/**
 * Web search (Brave) — host-side wiring.
 *
 * The `brave_web_search` tool lives in the agent-runner
 * (`container/agent-runner/src/mcp-tools/search.ts`) and registers only when
 * BRAVE_API_KEY is in the container environment. The container gets the
 * native proxy's Brave route and the install placeholder in that slot — the
 * real key stays in the host's `.env` and is attached by the proxy. Every
 * session, specialists included, since the Researcher is the heaviest user.
 *
 * Disabled unless BRAVE_API_KEY is in `.env` and the gateway is the native
 * proxy.
 */
import { registerSessionContributor } from '../../container-runner.js';
import { proxiedService } from '../../gateway-providers/native-proxy.js';

registerSessionContributor(() => {
  const brave = proxiedService('brave');
  return brave ? { env: { BRAVE_API_KEY: brave.token, BRAVE_API_BASE: brave.baseUrl } } : undefined;
});
