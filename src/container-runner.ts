/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  TIMEZONE,
  WEB_UI_BASE_URL,
} from './config.js';
import { detectAuthMode } from './credential-proxy.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig, updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup, isMainGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { getSpecialist } from './modules/specialists/db.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { readEnvFile } from './env.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import { resetStaleProcessingSessions } from './db/sessions.js';
import type { AgentGroup, Session } from './types.js';

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

// ── Concurrency cap + FIFO waiting queue ────────────────────────────────────

interface WaitingEntry {
  session: Session;
  queuedAt: number;
}

/** Sessions queued because the concurrency cap is full. FIFO ordered by queuedAt. */
const waitingQueue: WaitingEntry[] = [];

/**
 * Session IDs for non-main containers that are currently running or have a
 * reserved slot mid-spawn. Main-group sessions are never counted here because
 * they bypass the cap entirely.
 */
const activeNonMainSessions = new Set<string>();

// Internal wake function pointer — tests override this to avoid real Docker spawning.
let _wakeImpl: (session: Session) => Promise<boolean> = wakeContainer;

/** @internal Test seam — override the inner wake step without real Docker spawning. */
export function _setWakeImplForTesting(fn: (session: Session) => Promise<boolean>): void {
  _wakeImpl = fn;
}

/** @internal Test seam — reset all queue state and restore the default wake implementation. */
export function _resetQueueStateForTesting(): void {
  waitingQueue.length = 0;
  activeNonMainSessions.clear();
  _wakeImpl = wakeContainer;
}

/** @internal Test seam — simulate a container exit, releasing its slot and draining the queue. */
export function _simulateContainerExitForTesting(sessionId: string): void {
  activeNonMainSessions.delete(sessionId);
  drainWaiting();
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Reset stale processing_state on startup. Must be called once, after orphan
 * containers are stopped, before any wakeOrQueue calls. Containers are gone
 * after a host restart, so sessions left in 'processing' would silently
 * under-count the concurrency cap until the next sweep.
 */
export function initConcurrencyCap(): void {
  const reset = resetStaleProcessingSessions();
  if (reset > 0) {
    log.info('Reset stale processing sessions to idle on startup', { count: reset });
  }
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

/**
 * Wake a container for a session, respecting the concurrency cap.
 *
 * Main-group sessions bypass the cap and always wake immediately.
 * Non-main sessions queue when `activeNonMainSessions.size >= MAX_CONCURRENT_CONTAINERS`
 * and are woken in FIFO order as slots free up on container exit.
 *
 * Returns true if the container was woken (or was already running), false if queued.
 * Never throws — callers that only care about whether work started can ignore the return.
 */
export function wakeOrQueue(session: Session): Promise<boolean> {
  if (isMainGroup(session.agent_group_id)) return _wakeImpl(session);

  // Already running or mid-spawn — reuse the existing state.
  if (activeContainers.has(session.id) || wakePromises.has(session.id)) {
    return Promise.resolve(true);
  }

  // Already in the waiting queue — don't double-enqueue.
  if (waitingQueue.some((w) => w.session.id === session.id)) {
    log.debug('Session already in waiting queue', { sessionId: session.id });
    return Promise.resolve(false);
  }

  if (activeNonMainSessions.size < MAX_CONCURRENT_CONTAINERS) {
    // Reserve the slot synchronously before the async wake to prevent a race
    // where two concurrent calls both see size < cap and both spawn.
    activeNonMainSessions.add(session.id);
    return _wakeImpl(session).then((ok) => {
      if (!ok) {
        // Wake failed — release the reserved slot and drain in case waiters can use it.
        activeNonMainSessions.delete(session.id);
        drainWaiting();
      }
      return ok;
    });
  }

  // Cap reached — queue in FIFO order.
  waitingQueue.push({ session, queuedAt: Date.now() });
  log.info('Session queued (concurrency cap reached)', {
    sessionId: session.id,
    agentGroup: session.agent_group_id,
    queuePos: waitingQueue.length,
    activeNonMain: activeNonMainSessions.size,
    cap: MAX_CONCURRENT_CONTAINERS,
  });
  return Promise.resolve(false);
}

function drainWaiting(): void {
  while (waitingQueue.length > 0 && activeNonMainSessions.size < MAX_CONCURRENT_CONTAINERS) {
    const next = waitingQueue.shift()!;
    // Reserve the slot before the async wake.
    activeNonMainSessions.add(next.session.id);
    log.info('Dequeuing waiting session', {
      sessionId: next.session.id,
      agentGroup: next.session.agent_group_id,
      waitedMs: Date.now() - next.queuedAt,
    });
    _wakeImpl(next.session)
      .then((ok) => {
        if (!ok) {
          activeNonMainSessions.delete(next.session.id);
          drainWaiting();
        }
      })
      .catch(() => {
        activeNonMainSessions.delete(next.session.id);
        drainWaiting();
      });
  }
}

/** Returns current concurrency queue status for observability. */
export function getQueueStatus(): { activeNonMain: number; max: number; waiting: number } {
  return { activeNonMain: activeNonMainSessions.size, max: MAX_CONCURRENT_CONTAINERS, waiting: waitingQueue.length };
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution);

  // Invocation lifecycle for specialist file-handover (no-op if tables absent)
  let invocationId: string | undefined;
  if (hasTable(getDb(), 'invocations')) {
    try {
      const { buildInvocationForSession } = await import('./modules/specialists/invocation.js');
      const result = buildInvocationForSession(session);
      if (result) {
        mounts.push(...result.mounts);
        invocationId = result.invocationId;
      }
    } catch (err) {
      log.debug('container-runner: invocation setup skipped', { err });
    }
  }

  const containerName = `nanoclaw-v2-${agentGroup.folder.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${Date.now()}`;
  const args = buildContainerArgs(mounts, containerName, containerConfig, contribution);

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    activeNonMainSessions.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
    if (invocationId) {
      import('./modules/specialists/invocation.js')
        .then(({ endInvocationById }) => endInvocationById(invocationId!))
        .catch((err) => log.warn('container-runner: invocation cleanup failed', { invocationId, err }));
    }
    drainWaiting();
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    activeNonMainSessions.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
    drainWaiting();
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Write nanoclaw_meta.json into the session dir so the container can read it
  // from /workspace/nanoclaw_meta.json. The container never receives WEB_UI_BASE_URL
  // as an env var — the file is the sole source so the host can change the URL
  // without rebuilding or restarting containers.
  fs.writeFileSync(
    path.join(sessDir, 'nanoclaw_meta.json'),
    JSON.stringify({ webUiBaseUrl: WEB_UI_BASE_URL, groupFolder: agentGroup.folder }, null, 2),
  );

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent.
  // Non-specialist groups mount RW so the agent can update CLAUDE.local.md (auto-memory).
  // Specialist groups share this type-template folder across concurrent tasks — mount RO
  // so no running task can mutate the template or affect sibling tasks. Per-task state
  // for specialists lives exclusively in the session DBs under /workspace.
  const isSpecialist = !!getSpecialist(agentGroup.id);
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: isSpecialist });

  // container.json and CLAUDE.md are inside groupDir (mounted as /workspace/agent above).
  // Apple Container only supports directory mounts, not file-level bind mounts,
  // so the nested RO overlays used with Docker cannot be used here. For non-specialist
  // groups, the files remain writable. container.json is rewritten at spawn time and
  // CLAUDE.md is regenerated on every spawn — so agent-side writes to those two files
  // are silently lost on the next spawn. CLAUDE.local.md is the correct target for
  // any persistent per-group instructions; it survives across spawns and is included
  // into the composed CLAUDE.md. For specialist groups the entire mount is RO.

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md is baked into the image at /app/CLAUDE.md (see Dockerfile COPY step)
  // so no mount is needed here. Apple Container doesn't support file-level bind mounts.

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Per-group memory index — read-only so agents can run FTS5 / vector search
  // directly via bun:sqlite without host round-trip. Non-specialist only: specialists
  // use query_memory tool routed through a memory-provider group.
  const memoryEnabled = !isSpecialist && fs.existsSync(path.join(DATA_DIR, 'v2-memory', agentGroup.id));
  if (memoryEnabled) {
    mounts.push({
      hostPath: path.join(DATA_DIR, 'v2-memory', agentGroup.id),
      containerPath: '/workspace/memory',
      readonly: true,
    });
  }

  // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
  // fragments, and MCP server instructions. Done after memory is resolved so
  // we can omit the memory fragment when the tools are not registered.
  composeGroupClaudeMd(agentGroup, {
    disabledModules: memoryEnabled ? undefined : new Set(['memory']),
  });

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set ('all' recomputes from container/skills/).
  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
): string[] {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Memory — signal to the container that the memory MCP tools should be registered.
  // Inferred from mounts: the host only mounts /workspace/memory for non-specialist
  // groups whose index directory exists (i.e. in the MEMORY_SEARCH_GROUPS allowlist).
  if (mounts.some((m) => m.containerPath === '/workspace/memory')) {
    args.push('-e', 'NANOCLAW_MEMORY_ENABLED=1');
  }

  // Optional third-party API keys — only injected if present in .env.
  const optionalSecrets = readEnvFile(['BRAVE_API_KEY', 'ZOTERO_API_KEY', 'ZOTERO_USER_ID']);
  if (optionalSecrets.BRAVE_API_KEY) {
    args.push('-e', `BRAVE_API_KEY=${optionalSecrets.BRAVE_API_KEY}`);
  }
  if (optionalSecrets.ZOTERO_API_KEY) {
    args.push('-e', `ZOTERO_API_KEY=${optionalSecrets.ZOTERO_API_KEY}`);
  }
  if (optionalSecrets.ZOTERO_USER_ID) {
    args.push('-e', `ZOTERO_USER_ID=${optionalSecrets.ZOTERO_USER_ID}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Credential proxy — route container API calls through the host-side proxy
  // which injects real credentials so containers never hold them directly.
  // Containers connect to the bridge gateway IP where the proxy is listening.
  args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`);
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }
  log.debug('Credential proxy wired', { containerName, gateway: CONTAINER_HOST_GATEWAY, port: CREDENTIAL_PROXY_PORT });

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
