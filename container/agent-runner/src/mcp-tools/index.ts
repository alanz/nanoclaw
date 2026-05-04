/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 *
 * Conditional tools: some modules are only registered when the host signals
 * they are available for this container. Currently:
 *   NANOCLAW_MEMORY_ENABLED — set when /workspace/memory is mounted (non-specialist
 *     group in the MEMORY_SEARCH_GROUPS allowlist). Absent for specialist containers
 *     and groups not in the allowlist.
 */
import './core.js';
import './scheduling.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './specialists.js';
if (process.env.NANOCLAW_MEMORY_ENABLED) {
  await import('./memory.js');
}
import './search.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
