/**
 * buildAgentGroupImage interpolates a group's package names into Dockerfile
 * RUN lines. Every intake path validates the names, so this is the backstop
 * for a row stored before that existed (or edited by hand): the build refuses
 * before it reaches a runtime, let alone a shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildAgentGroupImage } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';

const GID = 'ag-build';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: GID,
    name: 'b',
    folder: 'b',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(GID);
});
afterEach(async () => {
  await closeDb();
});

describe('buildAgentGroupImage package names', () => {
  it('refuses to build with a stored name that is not a package name', async () => {
    await updateContainerConfigJson(GID, 'packages_apt', ['jq', 'curl; id']);
    await updateContainerConfigJson(GID, 'packages_npm', ['left-pad && id']);
    await expect(buildAgentGroupImage(GID)).rejects.toThrow(
      /Invalid package name\(s\).*apt "curl; id", npm "left-pad && id".*remove-package/,
    );
  });
});
