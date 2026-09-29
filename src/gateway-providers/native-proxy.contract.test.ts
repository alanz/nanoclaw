/**
 * Native credential proxy against the gateway-provider contract: what a
 * session lease carries, and that the proxy's lifetime is the approval
 * subscription's (started with it, closed when the host aborts it).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dataDir, close, start } = vi.hoisted(() => {
  const close = vi.fn((cb: () => void) => cb());
  return {
    dataDir: { current: '' },
    close,
    start: vi.fn(async () => ({ close })),
  };
});
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return dataDir.current;
  },
}));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../credential-proxy.js', () => ({ startCredentialProxy: start, detectAuthMode: () => 'oauth' }));

import { getGatewayProviderRegistration } from './gateway-provider-registry.js';
import { NATIVE_PROXY_GATEWAY_KIND, proxySecret, resetCredentialProxy } from './native-proxy.js';

dataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-proxy-contract-'));
afterAll(() => fs.rmSync(dataDir.current, { recursive: true, force: true }));

const provider = getGatewayProviderRegistration(NATIVE_PROXY_GATEWAY_KIND)!;
const input = {
  key: { installSlug: 'i', agentGroupId: 'g', sessionId: 's' },
  runtimeIdentity: 'i/g/s',
  groupName: 'Andy',
  containerName: 'ncl-i-s',
  capabilities: {} as never,
};

beforeEach(() => {
  resetCredentialProxy();
  start.mockClear();
  close.mockClear();
  process.env.CREDENTIAL_PROXY_GATEWAY = '10.0.0.1';
});

describe('native-proxy gateway contract', () => {
  it('registers with no agent skills', () => {
    expect(provider.agentSkills).toEqual([]);
  });

  it('leases a placeholder env and a host network target, starting the proxy', async () => {
    const lease = await provider.sessions.ensure(input, new AbortController().signal);
    expect(start).toHaveBeenCalledTimes(1);
    expect(lease.contribution.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://10.0.0.1:3002',
      CLAUDE_CODE_OAUTH_TOKEN: proxySecret(dataDir.current),
    });
    expect(lease.contribution.networkAccess).toEqual({ endpoint: '10.0.0.1', target: { kind: 'host' } });
  });

  it('keeps the approval subscription open until aborted, then closes the proxy', async () => {
    const controller = new AbortController();
    let settled = false;
    const subscription = provider.approvals.subscribe(async () => 'deny', controller.signal).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(start).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    controller.abort();
    await subscription;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects the subscription when the proxy cannot start, and retries on the next call', async () => {
    start.mockRejectedValueOnce(new Error('EADDRINUSE'));
    await expect(provider.approvals.subscribe(async () => 'deny', new AbortController().signal)).rejects.toThrow(
      'EADDRINUSE',
    );
    await provider.sessions.ensure(input, new AbortController().signal);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
