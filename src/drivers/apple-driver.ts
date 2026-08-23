/**
 * Apple Container driver — a dialect, not a second driver.
 *
 * `container` (Apple's macOS runtime, https://github.com/apple/container) is
 * close enough to Docker at the argv level that the whole of
 * `DockerSessionDriver`'s realization policy applies unchanged: `create` +
 * `start --attach`, `--label`, `--rm`, `-v host:ctr:ro`, `--user uid:gid`,
 * `--memory`, `--cpus`, `--entrypoint` and `--init` all spell the same. What
 * differs is how you ASK it things, which is exactly what `RuntimeDialect`
 * isolates — so this file is a dialect plus one `registerSessionDriver` call,
 * and carries no copy of the driver's internals.
 *
 * Four divergences, all handled below:
 *
 *   1. No `events` subcommand. The subscription polls instead. A poller cannot
 *      drop, so it never calls `onEnd` and the driver never reconnects it —
 *      the backoff and gap-reconciliation machinery simply never engages.
 *   2. No `--filter` on `ls`. Listing is `ls --all --format json` and the
 *      label match happens here.
 *   3. No `--pids-limit` and no `--security-opt`. Both are omitted rather
 *      than faked: see `hardeningArgs`.
 *   4. No `--add-host`. Containers reach the host over the bridge address, so
 *      the driver is registered with an empty network contribution and host
 *      services bind an address the bridge can route to.
 *
 * Selection: `NANOCLAW_RUNTIME_DRIVER=apple` in `.env` (or the environment).
 */
import { statSync } from 'node:fs';

import { log } from '../log.js';

import type { Cli } from './cli.js';
import type { RuntimeDialect, RuntimeResidue, RuntimeRow } from './dialect.js';
import { DockerSessionDriver } from './docker-driver.js';
import { registerSessionDriver } from './driver-registry.js';
import { LABELS, type SessionEvent, type SessionPhase, type SessionSpec } from './types.js';

export const APPLE_DRIVER_KIND = 'apple';

/**
 * How often the subscription re-lists. Bounds how long a terminal transition
 * can go unnoticed; the hub re-reads truth before acting on any hint, so this
 * trades latency for `ls` calls and nothing else.
 */
const POLL_INTERVAL_MS = 2_000;

/** The subset of `container ls --format json` this dialect reads. */
interface AppleContainerDoc {
  id?: string;
  configuration?: { id?: string; labels?: Record<string, string> };
  status?: { state?: string };
}

function parseDocs(out: string): AppleContainerDoc[] {
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as AppleContainerDoc[]) : [];
  } catch {
    // A runtime that answered with something unparseable is a runtime we
    // cannot enumerate; treating that as "no containers" would reap nothing
    // and adopt nothing, which is the safe direction.
    return [];
  }
}

/**
 * A path that exists and is not a directory. A source that does not exist yet
 * is treated as a directory: composition already gated on existence, and
 * guessing "file" for a missing path would drop a mount the runtime could
 * have made.
 */
function isFileMount(hostPath: string): boolean {
  try {
    return !statSync(hostPath).isDirectory();
  } catch {
    return false;
  }
}

function docName(doc: AppleContainerDoc): string {
  // `--name` sets the container id here, so id IS the name the driver allocated.
  return doc.id ?? doc.configuration?.id ?? '';
}

function docLabels(doc: AppleContainerDoc): Record<string, string> {
  return doc.configuration?.labels ?? {};
}

function listInstallDocs(cli: Cli, installSlug: string): AppleContainerDoc[] {
  const docs = parseDocs(cli.run(['ls', '--all', '--format', 'json']));
  return docs.filter((doc) => docLabels(doc)[LABELS.install] === installSlug);
}

function toRow(doc: AppleContainerDoc): RuntimeRow {
  const labels = docLabels(doc);
  return {
    name: docName(doc),
    state: doc.status?.state ?? '',
    agentGroupId: labels[LABELS.group] ?? '',
    sessionId: labels[LABELS.session] ?? '',
  };
}

/**
 * `container ls` state → seam phase.
 *
 * Mirrors `dockerStatePhase`'s bias: anything not positively known to be
 * live-or-becoming-live is a corpse, because the cost of misreading a corpse
 * as running (a session that never gets reaped) is lower than misreading a
 * freshly-created container as terminal (adoption tearing down the session it
 * just prepared).
 */
export function appleStatePhase(state: string): SessionPhase {
  if (state === 'running') return 'running';
  if (state === 'created' || state === 'starting' || state === 'preparing') return 'starting';
  return 'terminal';
}

export const appleDialect: RuntimeDialect = {
  kind: APPLE_DRIVER_KIND,
  bin: 'container',

  ensureReady(cli) {
    try {
      cli.run(['system', 'status'], { timeoutMs: 10_000 });
      log.debug('Container runtime already running');
      return;
    } catch {
      log.info('Apple Container services not running, starting them');
    }
    try {
      cli.run(['system', 'start'], { timeoutMs: 60_000 });
      log.info('Apple Container services started');
    } catch (err) {
      log.error('Failed to reach container runtime', { err });
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Container runtime failed to start                      ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without a container runtime. To fix:        ║');
      console.error('║  1. Ensure Apple Container is installed (brew install container)║');
      console.error('║  2. Run: container system start                                ║');
      console.error('║  3. Restart NanoClaw                                           ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Container runtime is required but failed to start', { cause: err });
    }
  },

  /**
   * 'standard' posture, Apple dialect.
   *
   * `--cap-drop=ALL` and `--init` carry over. `--security-opt` and
   * `--pids-limit` have no spelling here, so they are omitted rather than
   * approximated — a dialect that silently dropped a requested pids cap while
   * the spec still claimed one would report a posture the runtime is not
   * enforcing. Both are depth-in-defence on Docker too (see the note on
   * `hardeningArgs` there): containers run under `--user`, so the capability
   * sets are already empty.
   */
  hardeningArgs(spec: SessionSpec): string[] {
    void spec;
    return ['--cap-drop=ALL', '--init'];
  },

  statePhase: appleStatePhase,

  /**
   * Directory mounts only.
   *
   * `container` cannot bind a single file — passing it one fails the spawn
   * outright, so a file mount is dropped here rather than allowed to kill the
   * session. The one file mount trunk composes is `container/CLAUDE.md` at
   * /app/CLAUDE.md, which the image already carries (see the COPY in
   * container/Dockerfile); dropping the mount leaves the baked copy in place.
   *
   * Logged, not silent: a mount that was asked for and not made is exactly
   * the kind of difference that should be visible when a session behaves
   * unexpectedly.
   */
  mountArgs(mounts) {
    const args: string[] = [];
    for (const m of mounts) {
      if (isFileMount(m.hostPath)) {
        log.debug('Apple Container: dropping file mount (directories only)', {
          hostPath: m.hostPath,
          containerPath: m.containerPath,
        });
        continue;
      }
      args.push('-v', m.mode === 'ro' ? `${m.hostPath}:${m.containerPath}:ro` : `${m.hostPath}:${m.containerPath}`);
    }
    return args;
  },

  listAgents(cli, installSlug): RuntimeRow[] {
    return listInstallDocs(cli, installSlug)
      .filter((doc) => docLabels(doc)[LABELS.role] === 'agent')
      .map(toRow);
  },

  listResidue(cli, installSlug): RuntimeResidue {
    const docs = listInstallDocs(cli, installSlug);
    return {
      stale: docs
        .filter((doc) => appleStatePhase(doc.status?.state ?? '') === 'terminal')
        .map(docName)
        .filter(Boolean),
      preSeam: docs
        .filter((doc) => doc.status?.state === 'running' && !docLabels(doc)[LABELS.session])
        .map(docName)
        .filter(Boolean),
    };
  },

  /**
   * Networks are not label-addressable here, and this driver contributes no
   * network arguments, so it never creates one to reap. Returning nothing is
   * the honest answer rather than an unsupported query.
   */
  listNetworks(): string[] {
    return [];
  },

  inspectLabels(cli, name) {
    let docs: AppleContainerDoc[];
    try {
      docs = parseDocs(cli.run(['inspect', name]));
    } catch {
      return null;
    }
    const doc = docs.find((d) => docName(d) === name) ?? docs[0];
    if (!doc) return null;
    const labels = docLabels(doc);
    return [labels[LABELS.install] ?? '', labels[LABELS.group] ?? '', labels[LABELS.session] ?? ''];
  },

  /**
   * `ls --all` rather than `inspect`: a failed inspect cannot tell a missing
   * container from an unreachable runtime, and that difference is the whole
   * point of the probe. A runtime that cannot answer throws here.
   */
  containerExists(cli, name) {
    return parseDocs(cli.run(['ls', '--all', '--format', 'json'])).some((doc) => docName(doc) === name);
  },

  /**
   * Polling stands in for `docker events`.
   *
   * Emits on transition only, comparing each poll against the last, so a
   * steady state costs one `ls` and no events. Both a state change and a
   * disappearance are reported — a `--rm` container that died between polls is
   * gone from `ls` entirely, and that absence is the only terminal signal
   * there will ever be for an adopted session.
   *
   * Never calls `onEnd`: a timer cannot drop the way a subscription process
   * can, so there is no gap to reconcile and no reconnect to schedule.
   */
  subscribe(cli, installSlug, onEvent, onEnd) {
    void onEnd;
    let previous = new Map<string, RuntimeRow>();
    let primed = false;
    let stopped = false;

    const poll = (): void => {
      if (stopped) return;
      let rows: RuntimeRow[];
      try {
        rows = appleDialect.listAgents(cli, installSlug);
      } catch (err) {
        // A failed poll is not a terminal signal: the runtime being briefly
        // unreachable must not be read as every session having ended.
        log.debug('Apple Container poll failed', { err });
        return;
      }
      const current = new Map<string, RuntimeRow>();
      for (const row of rows) {
        if (!row.agentGroupId || !row.sessionId) continue;
        current.set(`${row.agentGroupId} ${row.sessionId}`, row);
      }

      // The first poll establishes the baseline. Emitting for everything it
      // finds would hint a terminal for every already-dead container the list
      // still shows, on every host start.
      if (!primed) {
        previous = current;
        primed = true;
        return;
      }

      for (const [id, row] of current) {
        const before = previous.get(id);
        const phase = appleStatePhase(row.state);
        if (before && appleStatePhase(before.state) === phase) continue;
        const key = { installSlug, agentGroupId: row.agentGroupId, sessionId: row.sessionId };
        const event: SessionEvent = { key, kind: phase === 'terminal' ? 'terminal' : 'phase' };
        onEvent(event);
      }
      for (const [id, row] of previous) {
        if (current.has(id)) continue;
        const key = { installSlug, agentGroupId: row.agentGroupId, sessionId: row.sessionId };
        onEvent({ key, kind: 'terminal' });
      }
      previous = current;
    };

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    timer.unref?.();
    // Prime immediately so an adopted session is known before the first tick.
    poll();

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  },
};

registerSessionDriver(
  APPLE_DRIVER_KIND,
  (policy) => new DockerSessionDriver({ ...policy, dialect: appleDialect, networkArgsFor: () => [] }),
);
