/**
 * Apple dialect specifics.
 *
 * The shared realization contract is covered by `conformance.test.ts`, which
 * runs every case against this dialect too. What is left — and what this file
 * pins — is the four places Apple's CLI genuinely differs from Docker's:
 * client-side label filtering, residue classification, readiness, and the
 * polling subscription that stands in for `docker events`.
 */
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
  install?: string;
  group?: string;
  session?: string;
  role?: string;
}

function doc(o: DocOpts): unknown {
  const labels: Record<string, string> = {};
  if (o.install !== undefined) labels[LABELS.install] = o.install;
  if (o.group !== undefined) labels[LABELS.group] = o.group;
  if (o.session !== undefined) labels[LABELS.session] = o.session;
  if (o.role !== undefined) labels[LABELS.role] = o.role;
  return { id: o.name, configuration: { id: o.name, labels }, status: { state: o.state } };
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
      doc({ name: 'ncl-spike-s2', state: 'stopped', install: 'spike', group: 'g2', session: 's2', role: 'agent' }),
      // Running, install-labeled, but no session label: spawned before the seam.
      doc({ name: 'nanoclaw-v2-old-123', state: 'running', install: 'spike' }),
      doc({ name: 'ncl-other-s1', state: 'stopped', install: 'other' }),
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
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'stopped', ...AGENT })]);
    const { events } = collect(cli);
    vi.advanceTimersByTime(5_000);
    expect(events).toEqual([]);
  });

  it('emits terminal when a container transitions to a dead state', () => {
    const cli = cliListing([doc({ name: 'ncl-spike-s1', state: 'running', ...AGENT })]);
    const { events } = collect(cli);
    cli.responses = [
      { match: /^ls --all/, output: JSON.stringify([doc({ name: 'ncl-spike-s1', state: 'stopped', ...AGENT })]) },
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
