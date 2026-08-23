/**
 * Apple dialect specifics.
 *
 * The shared realization contract is covered by `conformance.test.ts`, which
 * runs every case against this dialect too. What is left — and what this file
 * pins — is the four places Apple's CLI genuinely differs from Docker's:
 * client-side label filtering, residue classification, readiness, and the
 * polling subscription that stands in for `docker events`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appleDialect, appleStatePhase } from './apple-driver.js';
import { FakeCli } from './fake-cli.js';
import { LABELS, type SessionEvent } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface DocOpts {
  name: string;
  state: string;
  startedDate?: string;
  install?: string;
  group?: string;
  session?: string;
  role?: string;
}

function doc(o: DocOpts): unknown {
  // `startedDate` is what separates a prepared container from a dead one;
  // a fixture in a post-run state must carry it.
  const started = o.startedDate ?? (o.state === 'running' ? '2026-01-01T00:00:00Z' : undefined);
  const labels: Record<string, string> = {};
  if (o.install !== undefined) labels[LABELS.install] = o.install;
  if (o.group !== undefined) labels[LABELS.group] = o.group;
  if (o.session !== undefined) labels[LABELS.session] = o.session;
  if (o.role !== undefined) labels[LABELS.role] = o.role;
  return {
    id: o.name,
    configuration: { id: o.name, labels },
    status: started ? { state: o.state, startedDate: started } : { state: o.state },
  };
}

function cliListing(docs: unknown[]): FakeCli {
  const cli = new FakeCli('container');
  cli.responses = [{ match: /^ls --all/, output: JSON.stringify(docs) }];
  return cli;
}

const AGENT = { install: 'spike', group: 'g1', session: 's1', role: 'agent' };

describe('appleStatePhase', () => {
  it('reads only positively-live states as running', () => {
    expect(appleStatePhase('running')).toBe('running');
    expect(appleStatePhase('created')).toBe('starting');
    expect(appleStatePhase('stopped')).toBe('terminal');
    // An unknown state is a corpse, never dressed up as live — the same bias
    // dockerStatePhase takes, for the same reason.
    expect(appleStatePhase('who-knows')).toBe('terminal');
  });
});

describe('appleDialect.listAgents', () => {
  it('filters by install and agent role, since `ls` has no --filter', () => {
    const cli = cliListing([
      doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT }),
      // Another install sharing this runtime.
      doc({ name: 'ncl-other-s1', state: 'running', install: 'other', group: 'g9', session: 's9', role: 'agent' }),
      // This install, but not an agent container.
      doc({ name: 'ncl-spike-aux', state: 'running', install: 'spike', group: 'g1', session: 's1', role: 'proxy' }),
    ]);

    expect(appleDialect.listAgents(cli, 'spike')).toEqual([
      { name: 'ncl-spike-s1', state: 'running', agentGroupId: 'g1', sessionId: 's1' },
    ]);
    expect(cli.joined()).toEqual(['ls --all --format json']);
  });

  it('treats unparseable output as an empty runtime rather than throwing', () => {
    const cli = new FakeCli('container');
    cli.responses = [{ match: /^ls --all/, output: 'not json at all' }];
    expect(appleDialect.listAgents(cli, 'spike')).toEqual([]);
  });
});

describe('appleDialect.listResidue', () => {
  it('separates corpses from pre-seam containers', () => {
    const cli = cliListing([
      doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT }),
      doc({
        name: 'ncl-spike-s2',
        state: 'stopped',
        startedDate: '2026-01-01T00:00:00Z',
        install: 'spike',
        group: 'g2',
        session: 's2',
        role: 'agent',
      }),
      // Running, install-labeled, but no session label: spawned before the seam.
      doc({ name: 'nanoclaw-v2-old-123', state: 'running', install: 'spike' }),
      doc({ name: 'ncl-other-s1', state: 'stopped', startedDate: '2026-01-01T00:00:00Z', install: 'other' }),
    ]);

    expect(appleDialect.listResidue(cli, 'spike')).toEqual({
      stale: ['ncl-spike-s2'],
      preSeam: ['nanoclaw-v2-old-123'],
    });
  });
});

describe('appleDialect.hardeningArgs', () => {
  it('omits flags the runtime cannot enforce rather than faking them', () => {
    const args = appleDialect.hardeningArgs({ resources: { pidsLimit: 512 } } as never);
    expect(args).toEqual(['--cap-drop=ALL', '--init']);
    expect(args.join(' ')).not.toContain('--pids-limit');
    expect(args.join(' ')).not.toContain('--security-opt');
  });
});

describe('appleDialect.ensureReady', () => {
  it('starts the services when they are not already up', () => {
    const cli = new FakeCli('container');
    cli.responses = [{ match: /^system status/, throws: new Error('not running') }];
    appleDialect.ensureReady(cli);
    expect(cli.joined()).toEqual(['system status', 'system start']);
  });

  it('does not restart services that are already up', () => {
    const cli = new FakeCli('container');
    appleDialect.ensureReady(cli);
    expect(cli.joined()).toEqual(['system status']);
  });

  it('throws when the runtime cannot be brought up', () => {
    const cli = new FakeCli('container');
    cli.responses = [
      { match: /^system status/, throws: new Error('down') },
      { match: /^system start/, throws: new Error('still down') },
    ];
    expect(() => appleDialect.ensureReady(cli)).toThrow(/Container runtime is required/);
  });
});

describe('appleDialect.subscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function collect(cli: FakeCli): { events: SessionEvent[]; stop: () => void } {
    const events: SessionEvent[] = [];
    const sub = appleDialect.subscribe(
      cli,
      'spike',
      (e) => events.push(e),
      () => events.push({ kind: 'hint' } as never),
    );
    return { events, stop: sub.stop };
  }

  it('emits nothing for the state it finds on the first poll', () => {
    // Otherwise every host start would hint a terminal for every corpse the
    // runtime still lists.
    const cli = cliListing([
      doc({ name: 'ncl-spike-s1', state: 'stopped', startedDate: '2026-01-01T00:00:00Z', ...AGENT }),
    ]);
    const { events } = collect(cli);
    vi.advanceTimersByTime(5_000);
    expect(events).toEqual([]);
  });

  it('emits terminal when a container transitions to a dead state', () => {
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT })]);
    const { events } = collect(cli);
    cli.responses = [
      {
        match: /^ls --all/,
        output: JSON.stringify([
          doc({ name: 'ncl-spike-s1', state: 'stopped', startedDate: '2026-01-01T00:00:00Z', ...AGENT }),
        ]),
      },
    ];
    vi.advanceTimersByTime(2_000);
    expect(events).toEqual([{ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' }]);
  });

  it('emits terminal when a --rm container vanishes between polls', () => {
    // The only terminal signal an adopted session will ever get: the container
    // is gone from the listing entirely.
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT })]);
    const { events } = collect(cli);
    cli.responses = [{ match: /^ls --all/, output: '[]' }];
    vi.advanceTimersByTime(2_000);
    expect(events).toEqual([{ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' }]);
  });

  it('emits once per transition, not once per poll', () => {
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT })]);
    const { events } = collect(cli);
    cli.responses = [{ match: /^ls --all/, output: '[]' }];
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(1);
  });

  it('does not read a failed poll as every session ending', () => {
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT })]);
    const { events } = collect(cli);
    cli.responses = [{ match: /^ls --all/, throws: new Error('runtime unreachable') }];
    vi.advanceTimersByTime(6_000);
    expect(events).toEqual([]);
  });

  it('stops polling once stopped', () => {
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT })]);
    const { stop } = collect(cli);
    const before = cli.calls.length;
    stop();
    vi.advanceTimersByTime(10_000);
    expect(cli.calls.length).toBe(before);
  });
});

describe('appleDialect.mountArgs', () => {
  it('emits directory mounts with their mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mount-'));
    expect(
      appleDialect.mountArgs([
        { class: 'session', hostPath: dir, containerPath: '/workspace', mode: 'rw' },
        { class: 'surface', hostPath: dir, containerPath: '/app/src', mode: 'ro' },
      ] as never),
    ).toEqual(['-v', `${dir}:/workspace`, '-v', `${dir}:/app/src:ro`]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops a file mount, which this runtime cannot bind at all', () => {
    // `container` binds directories only; passing it a file fails the spawn.
    // The one file trunk composes (/app/CLAUDE.md) is baked into the image.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mount-'));
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# shared');

    expect(
      appleDialect.mountArgs([
        { class: 'surface', hostPath: file, containerPath: '/app/CLAUDE.md', mode: 'ro' },
        { class: 'session', hostPath: dir, containerPath: '/workspace', mode: 'rw' },
      ] as never),
    ).toEqual(['-v', `${dir}:/workspace`]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a mount whose source does not exist yet', () => {
    // Composition already gated on existence; guessing "file" for a missing
    // path would drop a mount the runtime could have made.
    expect(
      appleDialect.mountArgs([
        { class: 'session', hostPath: '/nope/not/here', containerPath: '/workspace', mode: 'rw' },
      ] as never),
    ).toEqual(['-v', '/nope/not/here:/workspace']);
  });
});

describe('prepared-vs-dead discrimination', () => {
  // Found against the real runtime, not the fake: `container create` leaves a
  // container in state `stopped`, exactly like one that ran and exited. The
  // only difference is `startedDate`, which appears when it actually runs.
  //
  // This matters between prepare() and start(): a residue sweep that read
  // `stopped` as terminal would remove the container it had just prepared,
  // and the start would fail on something that no longer exists.

  it('reads a created-but-never-started container as starting, not terminal', () => {
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'stopped', ...AGENT })]);
    expect(appleDialect.listAgents(cli, 'spike')[0].state).toBe('created');
    expect(appleDialect.statePhase(appleDialect.listAgents(cli, 'spike')[0].state)).toBe('starting');
  });

  it('reads a container that ran and exited as terminal', () => {
    const cli = cliListing([
      doc({ name: 'ncl-spike-s1', state: 'stopped', startedDate: '2026-01-01T00:00:00Z', ...AGENT }),
    ]);
    expect(appleDialect.statePhase(appleDialect.listAgents(cli, 'spike')[0].state)).toBe('terminal');
  });

  it('never reaps a container between prepare and start', () => {
    const cli = cliListing([
      doc({ name: 'ncl-prepared', state: 'stopped', ...AGENT }),
      doc({
        name: 'ncl-corpse',
        state: 'stopped',
        startedDate: '2026-01-01T00:00:00Z',
        install: 'spike',
        group: 'g2',
        session: 's2',
        role: 'agent',
      }),
    ]);
    expect(appleDialect.listResidue(cli, 'spike').stale).toEqual(['ncl-corpse']);
  });
});
