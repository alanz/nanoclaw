/**
 * Live-runtime conformance — the tier the fake CLI cannot reach.
 *
 * Everything else in this directory drives realization logic against
 * `FakeCli`, which answers whatever the test scripts it. That proves the
 * driver assembles the argv it meant to; it cannot prove the RUNTIME accepts
 * that argv, or that the fields the dialect reads back exist and mean what it
 * assumes.
 *
 * The gap is not theoretical. `container create` reports state `stopped` —
 * indistinguishable from a container that ran and exited — so the Apple
 * dialect's phase mapping was wrong in a way no scripted fake would surface
 * (see `normalizedState`). This file exists so the next one of those is found
 * by a test rather than in production, where `--rm` means the evidence is
 * already gone.
 *
 * SKIPPED unless a runtime and image are present, so it is inert in CI and on
 * a machine that has neither:
 *
 *   NANOCLAW_LIVE_RUNTIME=apple|docker   which runtime to exercise
 *   NANOCLAW_LIVE_IMAGE=<image:tag>      an image with bash on PATH
 *
 * These spawn real containers. They are named `ncl-live-*`, labelled with a
 * throwaway install slug, and removed in `afterAll` — nothing here can touch
 * a real session, whose names and labels differ.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appleDialect } from './apple-driver.js';
import { realCli } from './cli.js';
import { dockerDialect } from './docker-driver.js';
import type { RuntimeDialect } from './dialect.js';
import { LABELS } from './types.js';

const KIND = process.env.NANOCLAW_LIVE_RUNTIME ?? '';
const IMAGE = process.env.NANOCLAW_LIVE_IMAGE ?? '';
const DIALECT: RuntimeDialect | null = KIND === 'apple' ? appleDialect : KIND === 'docker' ? dockerDialect : null;

/** A slug no real install uses, so nothing here can collide with live state. */
const INSTALL = `livetest${process.pid}`;

function runtimeUsable(): boolean {
  if (!DIALECT || !IMAGE) return false;
  try {
    execFileSync(DIALECT.bin, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const maybe = runtimeUsable() ? describe : describe.skip;

maybe(`live runtime: ${KIND || 'none'}`, () => {
  // `describe.skip` still evaluates this body, so nothing here may assume a
  // runtime exists — construction is deferred to beforeAll, which does not run.
  let dialect: RuntimeDialect;
  let cli: ReturnType<typeof realCli>;
  const created: string[] = [];
  let workspace: string;

  function name(suffix: string): string {
    const n = `ncl-live-${process.pid}-${suffix}`;
    created.push(n);
    return n;
  }

  function labels(session: string): string[] {
    return [
      '--label',
      `${LABELS.install}=${INSTALL}`,
      '--label',
      `${LABELS.group}=g1`,
      '--label',
      `${LABELS.session}=${session}`,
      '--label',
      `${LABELS.role}=agent`,
    ];
  }

  beforeAll(() => {
    dialect = DIALECT!;
    cli = realCli(dialect.bin);
    dialect.ensureReady(cli);
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-live-'));
    fs.mkdirSync(path.join(workspace, 'group'), { recursive: true });
    fs.chmodSync(workspace, 0o777);
    fs.chmodSync(path.join(workspace, 'group'), 0o777);
  });

  afterAll(() => {
    for (const n of created) {
      try {
        cli.run(['rm', '--force', n]);
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('accepts the flags the driver actually emits', () => {
    // Every flag `prepare()` assembles, in one create. A runtime that rejects
    // any of them fails here rather than at the first real spawn.
    const n = name('flags');
    const args = [
      'create',
      '--rm',
      '--name',
      n,
      ...labels('flags'),
      '--memory',
      '512m',
      ...dialect.hardeningArgs({ resources: { pidsLimit: 256 } } as never),
      '--user',
      `${process.getuid?.()}:${process.getgid?.()}`,
      '-e',
      'HOME=/home/node',
      ...dialect.mountArgs([
        { class: 'session', hostPath: workspace, containerPath: '/workspace', mode: 'rw' },
      ] as never),
      '--entrypoint',
      'bash',
      IMAGE,
      '-c',
      'echo LIVE_OK',
    ];
    expect(() => cli.run(args)).not.toThrow();
  });

  it('reads back the canonical labels it stamped', () => {
    // The adoption contract: identity comes from labels alone. If the runtime
    // stores or reports them differently, adoption silently finds nothing.
    const rows = dialect.listAgents(cli, INSTALL);
    const row = rows.find((r) => r.sessionId === 'flags');
    expect(row).toBeDefined();
    expect(row!.agentGroupId).toBe('g1');
  });

  it('does not report a prepared container as terminal', () => {
    // The bug this file was written for. `create` leaves Apple in `stopped`,
    // which is also what an exited container reports; reading that as
    // terminal makes the residue sweep reap a container between prepare and
    // start.
    const row = dialect.listAgents(cli, INSTALL).find((r) => r.sessionId === 'flags');
    expect(dialect.statePhase(row!.state)).not.toBe('terminal');
  });

  it('does not offer a prepared container up for reaping', () => {
    expect(dialect.listResidue(cli, INSTALL).stale).not.toContain(`ncl-live-${process.pid}-flags`);
  });

  it('streams output and reports the exit code through start --attach', async () => {
    const n = name('attach');
    cli.run([
      'create',
      '--name',
      n,
      ...labels('attach'),
      '--entrypoint',
      'bash',
      IMAGE,
      '-c',
      'echo LIVE_STDOUT; exit 7',
    ]);

    const proc = cli.start(['start', '--attach', n], { captureStdout: true });
    const stdout: string[] = [];
    proc.onStdout((chunk) => stdout.push(chunk));
    const code = await new Promise<number | null>((resolve) => proc.onExit(resolve));

    expect(stdout.join('')).toContain('LIVE_STDOUT');
    // The attach channel IS the supervision channel — a runtime that swallowed
    // the exit code would make every failed session look like a clean end.
    expect(code).toBe(7);
  }, 60_000);

  it('reports a container that ran and exited as terminal', () => {
    const row = dialect.listAgents(cli, INSTALL).find((r) => r.sessionId === 'attach');
    expect(row).toBeDefined();
    expect(dialect.statePhase(row!.state)).toBe('terminal');
  });

  it('reads the labels of a named container for the idempotency check', () => {
    const found = dialect.inspectLabels(cli, `ncl-live-${process.pid}-attach`);
    expect(found).toEqual([INSTALL, 'g1', 'attach']);
  });

  it('returns null for a container that does not exist', () => {
    // prepare() treats null as "no existing session"; a throw here would
    // abort every first spawn instead.
    expect(dialect.inspectLabels(cli, `ncl-live-${process.pid}-absent`)).toBeNull();
  });
});
