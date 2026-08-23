/**
 * Runtime dialect — the CLI-shaped differences between container runtimes that
 * otherwise realize a session identically.
 *
 * `DockerSessionDriver` owns the *policy*: idempotency on key, admission,
 * atomic prepare, watch backoff, gap reconciliation, residue ordering. None of
 * that is runtime-specific. What IS runtime-specific is narrower than it looks
 * — how you ask the runtime a question, and how you spell an isolation flag.
 * That is this interface.
 *
 * The split is drawn so a dialect returns ROWS, not argv, to the driver, while
 * itself owning the argv it used to get them. A dialect that instead handed the
 * driver a filter expression would make every query's shape a negotiation
 * between the two, and the driver would end up encoding which runtimes support
 * server-side filtering — the exact knowledge this interface exists to hold.
 *
 * Docker's dialect lives in `docker-driver.ts` beside the driver it was
 * extracted from, so the default path has no extra hop and no import cycle.
 * Out-of-tree dialects (Apple `container`, podman, …) ship as overlays.
 */
import type { Cli } from './cli.js';
import type { MountSpec, SessionEvent, SessionPhase, SessionSpec } from './types.js';

/** One agent container, as the runtime reports it. Identity is labels, always. */
export interface RuntimeRow {
  name: string;
  /** Runtime-native state string; `statePhase` maps it to the seam's phases. */
  state: string;
  agentGroupId: string;
  sessionId: string;
}

/** Containers a dead host left behind, split by why they are reapable. */
export interface RuntimeResidue {
  /** Non-running containers of this install — safe to remove outright. */
  stale: string[];
  /** Running but session-label-less: spawned before the driver seam existed. */
  preSeam: string[];
}

/** A live subscription to lifecycle transitions. */
export interface RuntimeSubscription {
  stop(): void;
}

export interface RuntimeDialect {
  /** Driver kind. Reported by `capabilities()` and the selection log line. */
  readonly kind: string;

  /** CLI binary used when the caller injects no `Cli`. */
  readonly bin: string;

  /** Bring the runtime up, or throw a normalized failure. */
  ensureReady(cli: Cli): void;

  /**
   * 'standard' isolation posture in this runtime's spelling. Flags a runtime
   * does not implement are omitted rather than faked — a dialect claiming
   * `--pids-limit` it cannot enforce would report a posture it does not have.
   */
  hardeningArgs(spec: SessionSpec): string[];

  /** Runtime-native container state → seam phase. */
  statePhase(state: string): SessionPhase;

  /**
   * Mount flags for this runtime.
   *
   * Not every runtime binds every mount the same way. Docker binds single
   * files cleanly; Apple's `container` binds them by sharing the parent
   * directory, which collides with a directory mount of that same parent. A
   * dialect that cannot honor a mount has to be the thing that decides what
   * to do about it — the composer states what the session needs, and only the
   * realization knows what this runtime can express.
   */
  mountArgs(mounts: readonly MountSpec[]): string[];

  /** Agent containers of this install, running or not (the adoption contract). */
  listAgents(cli: Cli, installSlug: string): RuntimeRow[];

  /** Reapable containers of this install. */
  listResidue(cli: Cli, installSlug: string): RuntimeResidue;

  /** Install-labeled networks whose containers may already be gone. */
  listNetworks(cli: Cli, installSlug: string): string[];

  /**
   * The canonical labels on a named container, or null when it does not exist.
   * Ordered install, group, session — the triple `#existingSession` verifies
   * before adopting a name.
   */
  inspectLabels(cli: Cli, name: string): [string, string, string] | null;

  /**
   * Subscribe to lifecycle transitions for one install.
   *
   * `onEnd` reports that the subscription itself died, and is what drives the
   * driver's backoff and gap reconciliation. A dialect that cannot drop (a
   * poller) simply never calls it, and therefore never reconnects — the driver
   * needs no knowledge of which kind it is holding.
   */
  subscribe(
    cli: Cli,
    installSlug: string,
    onEvent: (event: SessionEvent) => void,
    onEnd: () => void,
  ): RuntimeSubscription;
}
