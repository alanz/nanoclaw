import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, hostname: '127.0.0.1', port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Stands in for the per-install placeholder a container is given. */
const TEST_SECRET = 'test-install-secret';

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamUrl: string | undefined;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    lastUpstreamUrl = undefined;
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamUrl = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy({ port: 0, host: '127.0.0.1', secret: TEST_SECRET });
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': TEST_SECRET,
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_SECRET}`,
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer real-oauth-token');
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy({ port: 0, host: '127.0.0.1', secret: TEST_SECRET });
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });
  // ── Injection is gated on the install secret ────────────────────────────
  //
  // The proxy binds broadly by necessity (the container bridge may not exist
  // when the host starts), so reachability cannot be the boundary. These pin
  // the boundary that replaced it: an arbitrary caller must never be able to
  // borrow the install's credential.

  it('does not inject the API key for a caller that lacks the install secret', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-attacker-guess' },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-attacker-guess');
    expect(lastUpstreamHeaders['x-api-key']).not.toBe('sk-ant-real-key');
  });

  it('does not inject the OAuth token for a caller that lacks the install secret', async () => {
    proxyPort = await startProxy({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real-token' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-secret' },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer not-the-secret');
    expect(lastUpstreamHeaders['authorization']).not.toContain('oauth-real-token');
  });

  it('passes an unrelated credential through untouched', async () => {
    // A temp key the container legitimately exchanged for carries on working:
    // gating injection must not turn the proxy into an allowlist.
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-temp-from-exchange' },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-temp-from-exchange');
  });

  // ── Service routes ──────────────────────────────────────────────────────
  //
  // Brave and Zotero keys stay on the host the same way the Anthropic one
  // does. The difference pinned here: a service route refuses a caller
  // without the install secret instead of relaying it.

  async function startServiceProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env);
    proxyServer = await startCredentialProxy({
      port: 0,
      host: '127.0.0.1',
      secret: TEST_SECRET,
      services: [
        {
          name: 'brave',
          upstream: `http://127.0.0.1:${upstreamPort}`,
          header: 'x-subscription-token',
          envKey: 'BRAVE_API_KEY',
        },
      ],
    });
    return (proxyServer.address() as AddressInfo).port;
  }

  it('swaps the install secret for the real service key and strips the route prefix', async () => {
    proxyPort = await startServiceProxy({ BRAVE_API_KEY: 'brave-real-key' });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/_svc/brave/res/v1/web/search?q=nanoclaw',
      headers: { 'x-subscription-token': TEST_SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamUrl).toBe('/res/v1/web/search?q=nanoclaw');
    expect(lastUpstreamHeaders['x-subscription-token']).toBe('brave-real-key');
  });

  it('refuses a service request without the install secret and never reaches upstream', async () => {
    proxyPort = await startServiceProxy({ BRAVE_API_KEY: 'brave-real-key' });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/_svc/brave/res/v1/web/search?q=x',
      headers: { 'x-subscription-token': 'someone-elses-key' },
    });

    expect(res.statusCode).toBe(403);
    expect(lastUpstreamUrl).toBeUndefined();
  });

  it('answers 404 for a service whose key is not configured', async () => {
    proxyPort = await startServiceProxy({});

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/_svc/brave/res/v1/web/search',
      headers: { 'x-subscription-token': TEST_SECRET },
    });

    expect(res.statusCode).toBe(404);
    expect(lastUpstreamUrl).toBeUndefined();
  });

  it('answers 404 for an unknown service', async () => {
    proxyPort = await startServiceProxy({ BRAVE_API_KEY: 'brave-real-key' });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/_svc/elsewhere/anything',
      headers: { 'x-subscription-token': TEST_SECRET },
    });

    expect(res.statusCode).toBe(404);
    expect(lastUpstreamUrl).toBeUndefined();
  });
});
