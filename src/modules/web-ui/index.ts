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
import fs from 'fs';
import path from 'path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { registerSessionContributor } from '../../container-runner.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { AgentGroup } from '../../types.js';
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

/**
 * Per-session metadata the container reads from /workspace/nanoclaw_meta.json.
 *
 * A file rather than an env var, deliberately: the base URL can change
 * without rebuilding an image or restarting a running container, and — more
 * to the point — the session spec's admission rules keep host configuration
 * out of container env. Written per session because that directory IS the
 * container's /workspace.
 */
function writeSessionMeta(group: Pick<AgentGroup, 'id' | 'folder'>, sessionId: string): void {
  try {
    const dir = sessionDir(group.id, sessionId);
    if (!fs.existsSync(dir)) return;
    fs.writeFileSync(
      path.join(dir, 'nanoclaw_meta.json'),
      JSON.stringify({ webUiBaseUrl: webUiBaseUrl(), groupFolder: group.folder }, null, 2),
    );
  } catch (err) {
    // Advisory metadata: a session that cannot read it simply has no
    // get_file_url, which is the same as not configuring the base URL.
    log.debug('Failed to write session metadata', { sessionId, err });
  }
}

// At every spawn, whatever created the session. A session-created hook is not
// enough: only the chat router fires it, so task and specialist sessions never
// got the file and their agents could not link to workspace files.
registerSessionContributor(({ agentGroup, session }) => {
  writeSessionMeta(agentGroup, session.id);
  return undefined;
});

let servers: Array<{ close(cb: () => void): void }> = [];

onHostStart(async () => {
  servers.push(startWebUi(webUiPort()));

  // Refresh existing sessions so a changed WEB_UI_BASE_URL takes effect on
  // restart — which is when a .env change takes effect anyway.
  for (const session of await getActiveSessions()) {
    const group = await getAgentGroup(session.agent_group_id);
    if (group) writeSessionMeta(group, session.id);
  }

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
