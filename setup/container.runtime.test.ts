import { describe, expect, it } from 'vitest';

import { chooseRuntime } from './container.js';

// The host runs sessions with the driver named by NANOCLAW_RUNTIME_DRIVER
// (default docker). Setup detected Apple Container on macOS and built with it
// but never recorded that, so a fresh macOS install built an Apple image and
// then ran Docker. chooseRuntime names the driver to record.
describe('chooseRuntime', () => {
  const apple = () => 'container';
  const docker = () => 'docker';

  it('records the apple driver when Apple Container is detected', () => {
    expect(chooseRuntime([], undefined, apple)).toEqual({ runtime: 'container', driver: 'apple' });
  });

  it('records the docker driver when Docker is detected', () => {
    expect(chooseRuntime([], undefined, docker)).toEqual({ runtime: 'docker', driver: 'docker' });
  });

  it('keeps a recorded choice over detection on a re-run', () => {
    expect(chooseRuntime([], 'docker', apple)).toEqual({ runtime: 'docker', driver: 'docker' });
    expect(chooseRuntime([], ' Apple ', docker)).toEqual({ runtime: 'container', driver: 'apple' });
  });

  it('lets --runtime override both', () => {
    expect(chooseRuntime(['--runtime', 'docker'], 'apple', apple)).toEqual({ runtime: 'docker', driver: 'docker' });
  });

  it('names no driver for an unknown runtime, and ignores an unknown recorded driver', () => {
    expect(chooseRuntime(['--runtime', 'podman'], undefined, docker).driver).toBeUndefined();
    expect(chooseRuntime([], 'podman', apple)).toEqual({ runtime: 'container', driver: 'apple' });
  });
});
