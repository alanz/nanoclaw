/** Capability barrel; mailbox skills replace mailbox/compose.ts, not this import. */
import '../mailbox/compose.js';

// Conditional tools: registered only when the host signals the capability is
// present for this container. NANOCLAW_MEMORY_ENABLED is set when
// /workspace/memory is mounted — a non-specialist group inside the
// MEMORY_SEARCH_GROUPS allowlist. Absent, the tool never registers and the
// agent is never told about a search it cannot run.
if (process.env.NANOCLAW_MEMORY_ENABLED) {
  await import('../mcp-tools/memory.js');
}
