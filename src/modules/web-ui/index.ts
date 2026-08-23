/**
 * Web UI and dashboard — host-side wiring.
 *
 * A read-only view over the install: agent groups, sessions, channels,
 * users, the memory graph, and a file viewer. Bound to loopback; expose it
 * through something that terminates TLS (Tailscale Serve, a reverse proxy)
 * rather than binding it publicly.
 *
 * The optional `@nanoco/nanoclaw-dashboard` pusher is separate and only
 * starts when DASHBOARD_SECRET is set — it ships periodic JSON snapshots to
 * a dashboard process rather than serving anything itself.
 */
import { readEnvFile } from '../../env.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { startWebUi } from '../../web-ui.js';

const SETTINGS = ['WEB_UI_PORT', 'WEB_UI_BASE_URL', 'DASHBOARD_SECRET', 'DASHBOARD_PORT'] as const;

function setting(key: (typeof SETTINGS)[number]): string {
  return process.env[key]?.trim() || readEnvFile([...SETTINGS])[key]?.trim() || '';
}

export function webUiPort(): number {
  return parseInt(setting('WEB_UI_PORT') || '3004', 10) || 3004;
}

/**
 * Public base URL, when one is configured. Written into the container's
 * metadata at spawn so an agent can hand a person a link to a workspace file
 * without ever holding the URL as an env var.
 */
export function webUiBaseUrl(): string | null {
  return setting('WEB_UI_BASE_URL').replace(/\/$/, '') || null;
}

let servers: Array<{ close(cb: () => void): void }> = [];

onHostStart(async () => {
  servers.push(startWebUi(webUiPort()));

  const secret = setting('DASHBOARD_SECRET');
  if (!secret) {
    log.info('Dashboard disabled (no DASHBOARD_SECRET)');
    return;
  }
  const port = parseInt(setting('DASHBOARD_PORT') || '3100', 10) || 3100;
  const { startDashboard } = await import('@nanoco/nanoclaw-dashboard');
  const { startDashboardPusher } = await import('../../dashboard-pusher.js');
  startDashboard({ port, secret });
  startDashboardPusher({ port, secret, intervalMs: 60_000 });
});

onHostShutdown(async () => {
  const closing = servers;
  servers = [];
  await Promise.all(closing.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});
