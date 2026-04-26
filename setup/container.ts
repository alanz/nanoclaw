/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 *
 * Runtime auto-detection: on macOS, prefers Apple Container (`container`
 * binary); falls back to Docker on Linux or when Apple Container is absent.
 * Pass `--runtime docker` or `--runtime apple-container` to override.
 */
import { execSync, spawnSync } from 'child_process';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

type DockerStatus = 'ok' | 'no-permission' | 'no-daemon' | 'other';
type RuntimeKind = 'apple-container' | 'docker';

// ─── Docker helpers ────────────────────────────────────────────────────────

function dockerStatus(): DockerStatus {
  const res = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
  if (/cannot connect|is the docker daemon running|no such file/i.test(err)) return 'no-daemon';
  return 'other';
}

/**
 * Try to start Docker if it's installed but idle. Poll up to 60s for the
 * daemon to come up — but bail immediately if the socket is reachable and
 * only blocked by a group-permission error, since that won't resolve by
 * waiting (the caller handles the sg re-exec for that case).
 */
async function tryStartDocker(): Promise<DockerStatus> {
  const platform = getPlatform();
  log.info('Docker not running — attempting to start', { platform });

  try {
    if (platform === 'macos') {
      execSync('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'linux') {
      // Inherit stdio so sudo can prompt for a password if needed.
      execSync('sudo systemctl start docker', { stdio: 'inherit' });
    } else {
      return 'other';
    }
  } catch (err) {
    log.warn('Start command failed', { err });
    return 'other';
  }

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = dockerStatus();
    if (s === 'ok') {
      log.info('Docker is up');
      return 'ok';
    }
    if (s === 'no-permission') {
      log.info('Docker daemon is up but socket is not accessible (group membership)');
      return 'no-permission';
    }
  }
  log.warn('Docker did not become ready within 60s');
  return 'no-daemon';
}

// ─── Apple Container helpers ───────────────────────────────────────────────

function appleContainerRunning(): boolean {
  const res = spawnSync('container', ['system', 'status'], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return res.status === 0;
}

async function tryStartAppleContainer(): Promise<boolean> {
  log.info('Apple Container not running — attempting to start');
  try {
    spawnSync('container', ['system', 'start'], { stdio: 'pipe' });
  } catch {
    // ignore — poll below will tell us if it worked
  }
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (appleContainerRunning()) {
      log.info('Apple Container is up');
      return true;
    }
  }
  log.warn('Apple Container did not become ready within 15s');
  return false;
}

// ─── Runtime detection ─────────────────────────────────────────────────────

function detectRuntime(override?: string): RuntimeKind | null {
  if (override === 'docker') return commandExists('docker') ? 'docker' : null;
  if (override === 'apple-container' || override === 'container') {
    return commandExists('container') ? 'apple-container' : null;
  }
  // Auto-detect: Apple Container first on macOS, Docker elsewhere
  if (process.platform === 'darwin' && commandExists('container')) return 'apple-container';
  if (commandExists('docker')) return 'docker';
  return null;
}

function parseArgs(args: string[]): { runtimeOverride?: string } {
  let runtimeOverride: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtimeOverride = args[i + 1];
      i++;
    }
  }
  return { runtimeOverride };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtimeOverride } = parseArgs(args);
  const image = getDefaultContainerImage(projectRoot);

  const runtime = detectRuntime(runtimeOverride);

  if (!runtime) {
    const wanted = runtimeOverride ?? 'apple-container or docker';
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtimeOverride ?? 'none',
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    log.error('No container runtime available', { wanted });
    process.exit(2);
  }

  // Build-args from .env. Only INSTALL_CJK_FONTS is passed through today.
  const buildArgs: string[] = [];
  try {
    const fs = await import('fs');
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg', 'INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env is optional; absence is normal on a fresh checkout
  }

  let buildOk = false;
  let testOk = false;

  if (runtime === 'apple-container') {
    // ── Apple Container ──────────────────────────────────────────────────

    if (!commandExists('container')) {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: 'apple-container',
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }

    if (!appleContainerRunning()) {
      const started = await tryStartAppleContainer();
      if (!started) {
        emitStatus('SETUP_CONTAINER', {
          RUNTIME: 'apple-container',
          IMAGE: image,
          BUILD_OK: false,
          TEST_OK: false,
          STATUS: 'failed',
          ERROR: 'runtime_not_available',
          LOG: 'logs/setup.log',
        });
        process.exit(2);
      }
    }

    log.info('Building container (Apple Container)', { buildArgs });
    const buildRes = spawnSync(
      'container',
      ['build', ...buildArgs, '-t', image, '.'],
      { cwd: path.join(projectRoot, 'container'), stdio: 'inherit' },
    );
    if (buildRes.status === 0) {
      buildOk = true;
      log.info('Container build succeeded');
    } else {
      log.error('Container build failed', { exitCode: buildRes.status });
    }

    if (buildOk) {
      log.info('Testing container (Apple Container)');
      try {
        const output = execSync(
          `container run --rm ${image} /bin/echo "Container OK"`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        testOk = output.includes('Container OK');
        log.info('Container test result', { testOk });
      } catch {
        log.error('Container test failed');
      }
    }
  } else {
    // ── Docker ───────────────────────────────────────────────────────────

    if (!commandExists('docker')) {
      log.info('Docker not found — running setup/install-docker.sh');
      try {
        execSync('bash setup/install-docker.sh', { cwd: projectRoot, stdio: 'inherit' });
      } catch (err) {
        log.warn('install-docker.sh failed', { err });
      }
    }

    if (!commandExists('docker')) {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: 'docker',
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }

    {
      let status = dockerStatus();
      if (status !== 'ok') {
        status = await tryStartDocker();
      }

      if (status === 'no-permission' && getPlatform() === 'linux' && commandExists('sg')) {
        log.info('Re-executing container step under `sg docker`');
        const res = spawnSync(
          'sg',
          ['docker', '-c', 'pnpm exec tsx setup/index.ts --step container'],
          { cwd: projectRoot, stdio: 'inherit' },
        );
        process.exit(res.status ?? 1);
      }

      if (status !== 'ok') {
        const error =
          status === 'no-permission' ? 'docker_group_not_active' : 'runtime_not_available';
        emitStatus('SETUP_CONTAINER', {
          RUNTIME: 'docker',
          IMAGE: image,
          BUILD_OK: false,
          TEST_OK: false,
          STATUS: 'failed',
          ERROR: error,
          LOG: 'logs/setup.log',
        });
        process.exit(2);
      }
    }

    log.info('Building container (Docker)', { buildArgs });
    const buildRes = spawnSync(
      'docker',
      ['build', ...buildArgs, '-t', image, '.'],
      { cwd: path.join(projectRoot, 'container'), stdio: 'inherit' },
    );
    if (buildRes.status === 0) {
      buildOk = true;
      log.info('Container build succeeded');
    } else {
      log.error('Container build failed', { exitCode: buildRes.status });
    }

    if (buildOk) {
      log.info('Testing container (Docker)');
      try {
        const output = execSync(
          `echo '{}' | docker run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        testOk = output.includes('Container OK');
        log.info('Container test result', { testOk });
      } catch {
        log.error('Container test failed');
      }
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
