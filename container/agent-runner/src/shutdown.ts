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

/** Set by the host for a specialist task's container (specialists module). */
export function isSpecialistContainer(): boolean {
  return process.env.NANOCLAW_SPECIALIST === '1';
}

/**
 * Ask the poll loop to exit cleanly once the current turn completes. Only a
 * specialist container honours it: the tools that call this are registered in
 * every container, and a main agent that called one by mistake must not stop.
 */
export function requestShutdown(): void {
  if (!isSpecialistContainer()) return;
  fs.writeFileSync(marker(), new Date().toISOString());
}

export function isShutdownRequested(): boolean {
  return fs.existsSync(marker());
}

export function clearShutdownRequest(): void {
  fs.rmSync(marker(), { force: true });
}

/**
 * Safety net for the exit itself. After a hand-off the poll loop aborts its
 * query and leaves the event loop, which waits for the provider's stream to
 * end — and a provider need not end it promptly on abort. Armed when the loop
 * decides to exit, cancelled when it returns normally; if it fires, the
 * process exits regardless. Unref'd, so it never keeps a process alive.
 */
let handoffExit: ReturnType<typeof setTimeout> | null = null;

export function armHandoffExit(): void {
  if (handoffExit) return;
  const graceMs = Number(process.env.NANOCLAW_HANDOFF_EXIT_GRACE_MS) || 10_000;
  handoffExit = setTimeout(() => {
    console.error('[shutdown] Poll loop did not finish after a hand-off — exiting anyway');
    process.exit(0);
  }, graceMs);
  handoffExit.unref?.();
}

export function disarmHandoffExit(): void {
  if (handoffExit) clearTimeout(handoffExit);
  handoffExit = null;
}
