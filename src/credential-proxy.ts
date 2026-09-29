/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * ── Why the placeholder is a secret ──────────────────────────────────────
 *
 * This process holds the install's real Anthropic credential and will attach
 * it to requests. Reachability therefore has to be the security boundary, and
 * for a long time it was the ONLY one: the proxy bound 0.0.0.0 and injected
 * credentials for any caller that arrived. On a laptop that joins untrusted
 * networks, that hands the account to anyone who can reach the port.
 *
 * Binding to the Apple Container bridge instead is the obvious fix and was
 * tried (9fc60f6a), but it is fragile in a way that made it revert: bridge100
 * does not exist until the container VM network comes up, so a host that
 * starts first cannot bind to it at all (EADDRNOTAVAIL).
 *
 * So the boundary moved into the request. The placeholder token the container
 * is given is a per-install secret, and injection happens ONLY for a caller
 * presenting it. Anything else is proxied verbatim — an unknown key is
 * upstream's business to reject, and passing it through leaks nothing. That
 * makes a broad bind survivable rather than load-bearing, and it does not
 * depend on which interfaces happen to exist at startup.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { timingSafeEqual } from 'crypto';

import { readEnvFile } from './env.js';
import { log } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

export interface CredentialProxyOptions {
  port: number;
  host: string;
  /**
   * The token containers present in place of a real credential. Injection is
   * gated on it; see the header note.
   */
  secret: string;
}

/** Constant-time compare that never throws on length mismatch. */
function secretMatches(presented: string | undefined, secret: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function startCredentialProxy(opts: CredentialProxyOptions): Promise<Server> {
  const { port, host, secret } = opts;
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // Inject only for the holder of the install secret. Every other
          // caller is proxied as it arrived and authenticates itself upstream.
          if (secretMatches(req.headers['x-api-key'] as string | undefined, secret)) {
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          }
        } else {
          const bearer = (req.headers['authorization'] as string | undefined)?.replace(/^Bearer /, '');
          // The token exchange is the only request carrying the placeholder;
          // afterwards the container holds a real temp key and needs no help.
          if (secretMatches(bearer, secret)) {
            delete headers['authorization'];
            if (oauthToken) headers['authorization'] = `Bearer ${oauthToken}`;
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          log.error('Credential proxy upstream error', { err, url: req.url });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      log.info('Credential proxy started', { port, host, authMode });
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
