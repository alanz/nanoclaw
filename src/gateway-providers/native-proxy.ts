/**
 * Native credential proxy — a gateway provider that needs no vault.
 *
 * The alternative to OneCLI for an install that keeps its Anthropic
 * credential in `.env`: a host-side proxy holds the real credential, and the
 * container is told to talk to it instead of `api.anthropic.com`. The
 * container never holds a credential, which is the same property the vault
 * provides, reached differently.
 *
 * This is the shape upstream's driver-seam notes point at for custom
 * endpoints — `ANTHROPIC_BASE_URL` plus a placeholder token — so the session
 * spec's admission rules (which refuse credential VALUES in container env)
 * are satisfied by construction: the only token that crosses is a
 * per-install placeholder, never the credential it stands for.
 *
 * Selection: `NANOCLAW_GATEWAY_PROVIDER=native-proxy` in `.env`.
 *
 * Lifecycle rides the contract rather than `src/index.ts`: the server starts
 * with the approval subscription the host opens for the selected gateway (or
 * on the first session, whichever comes first) and closes when that
 * subscription is aborted at shutdown. Installing this gateway is one appended
 * import, and an install that does not select it never opens the port.
 */
import type { Server } from 'http';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { detectAuthMode, startCredentialProxy } from '../credential-proxy.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';

export const NATIVE_PROXY_GATEWAY_KIND = 'native-proxy';

const SETTINGS = ['CREDENTIAL_PROXY_PORT', 'CREDENTIAL_PROXY_HOST', 'CREDENTIAL_PROXY_GATEWAY'] as const;

function setting(key: (typeof SETTINGS)[number]): string {
  return process.env[key]?.trim() || readEnvFile([...SETTINGS])[key]?.trim() || '';
}

export function proxyPort(): number {
  return parseInt(setting('CREDENTIAL_PROXY_PORT') || '3002', 10);
}

/**
 * The address a container uses to reach this host.
 *
 * Apple Container VMs arrive over the bridge, so the bridge's own address is
 * what they can route to; Docker publishes `host.docker.internal` instead.
 * Detected rather than configured because the bridge's address is assigned by
 * the runtime, but `CREDENTIAL_PROXY_GATEWAY` overrides when detection is
 * wrong for a given host.
 */
export function containerFacingHost(): string {
  const override = setting('CREDENTIAL_PROXY_GATEWAY');
  if (override) return override;
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  const ipv4 = bridge?.find((a) => a.family === 'IPv4');
  if (ipv4) return ipv4.address;
  // No bridge up yet. Apple Container's default subnet gateway is the right
  // guess on macOS; elsewhere the Docker driver's --add-host makes this name
  // resolve inside the container.
  return os.platform() === 'darwin' ? '192.168.64.1' : 'host.docker.internal';
}

/**
 * Where the listener binds.
 *
 * Defaults broad, because the bridge interface a container arrives on may not
 * exist when the host starts (see the header note in `credential-proxy.ts`).
 * That is safe here only because injection is gated on the install secret —
 * reachability alone buys an attacker nothing.
 */
function bindHost(): string {
  return setting('CREDENTIAL_PROXY_HOST') || '0.0.0.0';
}

const SECRET_FILE = 'credential-proxy.secret';

/**
 * The placeholder containers present, and the thing that makes it safe to
 * bind broadly. Persisted so a host restart does not invalidate the token a
 * running container still holds; 0600 because it is credential-equivalent
 * against this proxy.
 */
export function proxySecret(dataDir: string = DATA_DIR): string {
  const file = path.join(dataDir, SECRET_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const generated = randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  log.info('Generated credential proxy secret', { file });
  return generated;
}

let server: Server | null = null;
let starting: Promise<Server> | null = null;

/** Idempotent, and safe against concurrent spawns racing the first one. */
async function ensureProxyRunning(): Promise<void> {
  if (server) return;
  if (!starting) {
    starting = startCredentialProxy({ port: proxyPort(), host: bindHost(), secret: proxySecret() });
    // A failed start must not be memoized: the next session or subscription retries it.
    starting.catch(() => {
      starting = null;
    });
  }
  server = await starting;
}

function closeProxy(): Promise<void> {
  const open = server;
  server = null;
  starting = null;
  return new Promise<void>((resolve) => (open ? open.close(() => resolve()) : resolve()));
}

/** Test seam: drop the memoized server so a suite can start its own. */
export function resetCredentialProxy(): void {
  server = null;
  starting = null;
}

async function ensureSession(input: GatewaySessionInput): Promise<GatewaySessionLease> {
  // Fail-closed like every gateway: a session whose proxy did not come up
  // would reach Anthropic with a placeholder and get 401s it cannot explain.
  await ensureProxyRunning();

  const host = containerFacingHost();
  const secret = proxySecret();
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://${host}:${proxyPort()}`,
  };
  // The placeholder occupies whichever slot the mode's client reads, and is
  // the install secret rather than a literal — see `credential-proxy.ts`.
  if (detectAuthMode() === 'api-key') {
    env.ANTHROPIC_API_KEY = secret;
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = secret;
  }
  log.debug('Native credential proxy wired', {
    agentGroupId: input.key.agentGroupId,
    sessionId: input.key.sessionId,
    baseUrl: env.ANTHROPIC_BASE_URL,
  });
  // The proxy is a host process, not a runtime container or a session sidecar.
  return { contribution: { env, networkAccess: { endpoint: host, target: { kind: 'host' } } } };
}

/**
 * This gateway holds no requests for a human: the proxy injects or passes
 * through, and never asks. The contract still requires a subscription, and
 * reads one that ends while its signal is live as a failure — so it stays
 * open until the host aborts it.
 *
 * It is also the gateway's lifetime: the host opens it once at start and
 * aborts it at shutdown, so the proxy starts here and closes with it. A proxy
 * that cannot start rejects the subscription, which the host reports as the
 * gateway being unavailable and retries with backoff.
 */
async function subscribeApprovals(_decide: unknown, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await ensureProxyRunning();
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await closeProxy();
}

registerGatewayProvider({
  kind: NATIVE_PROXY_GATEWAY_KIND,
  agentSkills: [],
  sessions: { ensure: ensureSession },
  approvals: { subscribe: subscribeApprovals },
});
