/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/**
 * The container runtime binary name.
 * Override with CONTAINER_RUNTIME env var (e.g. CONTAINER_RUNTIME=docker for Linux).
 * Defaults to 'container' (Apple Container) on macOS, 'docker' on Linux.
 */
export const CONTAINER_RUNTIME_BIN =
  process.env.CONTAINER_RUNTIME ??
  (os.platform() === 'darwin' ? 'container' : 'docker');

/**
 * Hostname or IP containers use to reach the host machine.
 * Apple Container VMs can reach the host via the bridge IP directly.
 * Docker Desktop resolves host.docker.internal automatically.
 */
export const CONTAINER_HOST_GATEWAY =
  CONTAINER_RUNTIME_BIN === 'container'
    ? (detectAppleContainerBridgeIp() ?? 'host.docker.internal')
    : 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): bind to the bridge100 IP — VMs route via this bridge.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

/**
 * Detect the IP of Apple Container's VM bridge (bridge100 or similar).
 * Returns null if no bridge interface with a non-loopback IPv4 is found.
 */
function detectAppleContainerBridgeIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!name.startsWith('bridge')) continue;
    const ipv4 = addrs?.find((a) => a.family === 'IPv4' && !a.internal);
    if (ipv4) return ipv4.address;
  }
  return null;
}

function detectProxyBindHost(): string {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    // Apple Container VMs use a bridge network — bind to the bridge IP so containers can reach us.
    const bridgeIp = detectAppleContainerBridgeIp();
    if (bridgeIp) return bridgeIp;
    return '127.0.0.1';
  }

  if (os.platform() === 'darwin') return '127.0.0.1'; // Docker Desktop on macOS

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Apple Container uses the bridge IP directly (set in CONTAINER_HOST_GATEWAY) — no extra args needed.
  // Docker Desktop resolves host.docker.internal automatically on macOS.
  // On Linux, host.docker.internal isn't built-in — add it explicitly.
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

// Apple Container's startedDate is seconds since Jan 1, 2001 (Core Foundation epoch).
// Unix epoch is Jan 1, 1970. Offset: 978307200 seconds.
const CF_TO_UNIX_OFFSET_S = 978307200;

export interface OrphanedContainer {
  /** Full container name, e.g. nanoclaw-main-1773496586126 */
  name: string;
  /** Group folder safe name (special chars replaced with -), for matching to registered groups */
  safeName: string;
  /** Unix milliseconds when the container started */
  startedMs: number;
}

/** List running NanoClaw containers left over from a previous process. */
export function listOrphanedContainers(): OrphanedContainer[] {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: {
      status: string;
      startedDate?: number;
      configuration: { id: string };
    }[] = JSON.parse(output || '[]');

    return containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
      )
      .map((c) => {
        const name = c.configuration.id;
        // Container name format: nanoclaw-{safeName}-{13-digit-timestamp}
        const withoutPrefix = name.slice('nanoclaw-'.length);
        const tsMatch = withoutPrefix.match(/-(\d{13})$/);
        const safeName = tsMatch
          ? withoutPrefix.slice(0, -tsMatch[0].length)
          : withoutPrefix;
        const startedMs =
          c.startedDate != null
            ? (c.startedDate + CF_TO_UNIX_OFFSET_S) * 1000
            : Date.now();
        return { name, safeName, startedMs };
      });
  } catch {
    return [];
  }
}

/** Check if a named container is still running. */
export function isContainerRunning(name: string): boolean {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    return containers.some(
      (c) => c.status === 'running' && c.configuration.id === name,
    );
  } catch {
    return false;
  }
}

/** Kill a container by name. No-op if it has already stopped. */
export function killContainer(name: string): void {
  try {
    stopContainer(name);
  } catch {
    /* already stopped */
  }
}
