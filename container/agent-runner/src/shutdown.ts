let _requested = false;

/** Signal the poll loop to exit cleanly after the current turn completes. */
export function requestShutdown(): void {
  _requested = true;
}

export function isShutdownRequested(): boolean {
  return _requested;
}
