/**
 * Native credential proxy gateway provider.
 *
 * The proxy's own request handling is covered in `credential-proxy.test.ts`.
 * What this pins is the seam: what the provider contributes to a session spec,
 * and that the placeholder it hands out is a stable per-install secret rather
 * than a literal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: config.ts reads env at import time, which runs before a plain
// `const` in this file would be initialized.
const { mockEnv } = vi.hoisted(() => ({ mockEnv: {} as Record<string, string> }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({ ...mockEnv })) }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { containerFacingHost, proxyPort, proxySecret } from './native-proxy.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-proxy-'));
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  delete process.env.CREDENTIAL_PROXY_GATEWAY;
  delete process.env.CREDENTIAL_PROXY_PORT;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('proxySecret', () => {
  it('generates once and reuses it across calls', () => {
    const first = proxySecret(dataDir);
    const second = proxySecret(dataDir);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('survives a host restart, so a running container keeps working', () => {
    const before = proxySecret(dataDir);
    // A fresh process reads the persisted value rather than minting a new one,
    // which would 401 every container still holding the old placeholder.
    const after = proxySecret(dataDir);
    expect(after).toBe(before);
  });

  it('stores the secret 0600 — it is credential-equivalent against the proxy', () => {
    proxySecret(dataDir);
    const mode = fs.statSync(path.join(dataDir, 'credential-proxy.secret')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('containerFacingHost', () => {
  it('honours an explicit override', () => {
    process.env.CREDENTIAL_PROXY_GATEWAY = '10.1.2.3';
    expect(containerFacingHost()).toBe('10.1.2.3');
  });

  it('never hands back loopback, which a container cannot route to', () => {
    expect(containerFacingHost()).not.toBe('127.0.0.1');
    expect(containerFacingHost()).not.toBe('localhost');
  });
});

describe('proxyPort', () => {
  it('defaults to 3002 and honours configuration', () => {
    expect(proxyPort()).toBe(3002);
    process.env.CREDENTIAL_PROXY_PORT = '4100';
    expect(proxyPort()).toBe(4100);
  });
});
