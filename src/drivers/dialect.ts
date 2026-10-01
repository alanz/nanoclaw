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
import type { MountSpec, SessionEvent, SessionKey, SessionPhase, SessionSpec } from './types.js';

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

  /**
   * Whether this runtime can host auxiliary containers (a per-session gateway)
   * on a private per-session network. Reported as
   * `capabilities().auxiliaryContainers`; absent means no, and the driver then
   * refuses a spec that carries any.
   */
  readonly auxiliaryContainers?: boolean;

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

  /**
   * Names of a session's auxiliary containers, for adoption. Only a dialect
   * that declares `auxiliaryContainers` can have any; absent means none.
   */
  listAuxiliaries?(cli: Cli, key: SessionKey): string[];

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
   * Whether a named container still exists. Throws when the runtime cannot be
   * asked — that is what lets a failed `rm` tell auto-removal (`--rm` got there
   * first) from a runtime outage. Absent: a failed `rm` is treated as removed.
   */
  containerExists?(cli: Cli, name: string): boolean;

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

  /**
   * How this runtime builds and identifies images. Absent means it cannot
   * rebuild a group's image in place, and the driver reports
   * `capabilities().imageBuild` false — so install_packages is refused before
   * an admin is asked, not after.
   */
  readonly images?: RuntimeImages;
}

/**
 * Image operations for the per-group package layer (`buildAgentGroupImage`).
 *
 * That build is not a session, so it does not go through the driver; but it
 * has to run against the same runtime the sessions do, in that runtime's
 * spelling. Hard-coding one CLI there is how a host on Apple Container ended
 * up shelling a `docker` that was not installed.
 */
export interface RuntimeImages {
  /** The image's id, or null when it is absent or the runtime cannot say. */
  inspectId(cli: Cli, ref: string): string | null;
  /** Argv after the binary that builds `tag` from `dockerfile`, with the working directory as context. */
  buildArgs(tag: string, dockerfile: string): string[];
  /**
   * Make the builder ready. Returns how to put it back afterwards, when this
   * call is what brought it up — a runtime whose builder is a VM should not
   * leave one running for a build nobody is doing.
   */
  prepareBuild?(cli: Cli): (() => void) | void;
}

/**
 * Dialects of the drivers this process has constructed, by kind.
 *
 * Code that runs against the session runtime without being a session — the
 * image build — needs the dialect, and sees the driver only through the
 * session-events wrapper. The driver registers what it was built with; a
 * consumer looks it up by the driver's kind.
 */
const dialects = new Map<string, RuntimeDialect>();

export function registerRuntimeDialect(dialect: RuntimeDialect): void {
  dialects.set(dialect.kind, dialect);
}

export function getRuntimeDialect(kind: string): RuntimeDialect | undefined {
  return dialects.get(kind);
}
