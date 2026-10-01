/**
 * Image operations per runtime dialect — what `buildAgentGroupImage` shells.
 *
 * The bug these pin: per-group builds hard-coded `docker`, so a host running
 * sessions on Apple Container approved install_packages and then failed the
 * build on a binary that was not installed.
 */
import { describe, expect, it } from 'vitest';

import { appleDialect } from './apple-driver.js';
import { getRuntimeDialect, type RuntimeDialect } from './dialect.js';
import { DockerSessionDriver, dockerDialect } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import type { MountPolicy } from './types.js';

const policy = {
  groupsRoot: '/tmp/groups',
  dataRoot: '/tmp/data',
  surfaceRoots: [],
  materialsRoot: '/tmp/materials',
  gatewayTrustRoot: '/tmp/trust',
} as unknown as MountPolicy;

describe('apple image operations', () => {
  const images = appleDialect.images!;

  it('reads the id from the JSON `container image inspect` prints', () => {
    const cli = new FakeCli('container');
    cli.responses.push({
      match: /^image inspect base:latest$/,
      output: JSON.stringify([{ id: 'c1a9dc3c', configuration: { name: 'base:latest' } }]),
    });
    expect(images.inspectId(cli, 'base:latest')).toBe('c1a9dc3c');
    // No --format: Apple's CLI has none, and passing one is an error.
    expect(cli.calls[0].args).toEqual(['image', 'inspect', 'base:latest']);
  });

  it('answers null for a missing image or unreadable output', () => {
    const missing = new FakeCli('container');
    missing.responses.push({ match: /^image inspect/, throws: 'image not found' });
    expect(images.inspectId(missing, 'nope')).toBeNull();

    const garbled = new FakeCli('container');
    garbled.responses.push({ match: /^image inspect/, output: '<no value>' });
    expect(images.inspectId(garbled, 'base')).toBeNull();
  });

  it('builds with -t and -f, the working directory as context', () => {
    expect(images.buildArgs('img:ag-1', '/data/Dockerfile.ag-1')).toEqual([
      'build',
      '-t',
      'img:ag-1',
      '-f',
      '/data/Dockerfile.ag-1',
      '.',
    ]);
  });

  it('starts a stopped builder with a sized VM, and stops it again afterwards', () => {
    const cli = new FakeCli('container');
    cli.responses.push({ match: /^builder status$/, output: 'ID  IMAGE  STATE\nbuildkit  builder  stopped' });
    const restore = images.prepareBuild!(cli);
    expect(cli.calls.map((c) => c.args)).toContainEqual(['builder', 'start', '--memory', '8g']);
    expect(restore).toBeTypeOf('function');

    (restore as () => void)();
    expect(cli.calls.at(-1)?.args).toEqual(['builder', 'stop']);
  });

  it('leaves a builder that was already running alone, before and after', () => {
    const cli = new FakeCli('container');
    cli.responses.push({ match: /^builder status$/, output: 'ID  IMAGE  STATE\nbuildkit  builder  running' });
    expect(images.prepareBuild!(cli)).toBeUndefined();
    expect(cli.calls.map((c) => c.args)).toEqual([['builder', 'status']]);
  });
});

describe('docker image operations', () => {
  const images = dockerDialect.images!;

  it('keeps the formatted inspect and the build argv it always used', () => {
    const cli = new FakeCli('docker');
    cli.responses.push({ match: /^image inspect --format \{\{\.Id\}\} base$/, output: 'sha256:abc\n' });
    expect(images.inspectId(cli, 'base')).toBe('sha256:abc');
    expect(images.buildArgs('img:ag-1', 'Dockerfile.ag-1')).toEqual([
      'build',
      '-t',
      'img:ag-1',
      '-f',
      'Dockerfile.ag-1',
      '.',
    ]);
    expect(images.prepareBuild).toBeUndefined();
  });
});

describe('the imageBuild capability', () => {
  it('follows the dialect: a runtime without image operations cannot rebuild in place', () => {
    const withImages = new DockerSessionDriver({ ...policy, cli: new FakeCli('docker') });
    expect(withImages.capabilities().imageBuild).toBe(true);

    const bare: RuntimeDialect = { ...dockerDialect, kind: 'no-images', images: undefined };
    const without = new DockerSessionDriver({ ...policy, cli: new FakeCli('x'), dialect: bare });
    expect(without.capabilities().imageBuild).toBe(false);
  });

  it('makes the constructed driver’s dialect reachable by its kind', () => {
    const driver = new DockerSessionDriver({ ...policy, cli: new FakeCli('container'), dialect: appleDialect });
    expect(getRuntimeDialect(driver.kind)).toBe(appleDialect);
    expect(getRuntimeDialect(driver.kind)?.bin).toBe('container');
  });
});
