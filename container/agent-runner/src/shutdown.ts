/**
 * "Exit after this turn" — raised by a specialist tool, honoured by the poll loop.
 *
 * The two sides run in different processes: the MCP tools are a `bun run`
 * child of the provider, the poll loop is the runner itself. A module-level
 * flag set in one is invisible to the other (the pre-rebuild version was
 * exactly that, so no specialist container ever exited on request). A marker
 * file in the container's own /tmp is shared by both and dies with the
 * container, so a later container never inherits a stale request.
 */
import fs from 'fs';

function marker(): string {
  return process.env.NANOCLAW_SHUTDOWN_MARKER || '/tmp/nanoclaw-shutdown-requested';
}

/**
 * Ask the poll loop to exit cleanly once the current turn completes. Only a
 * specialist container honours it: the tools that call this are registered in
 * every container, and a main agent that called one by mistake must not stop.
 */
export function requestShutdown(): void {
  if (process.env.NANOCLAW_SPECIALIST !== '1') return;
  fs.writeFileSync(marker(), new Date().toISOString());
}

export function isShutdownRequested(): boolean {
  return fs.existsSync(marker());
}

export function clearShutdownRequest(): void {
  fs.rmSync(marker(), { force: true });
}
