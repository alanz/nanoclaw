/**
 * Session-scoped provider state: a session that must not share its group's
 * provider state (a specialist task) gets its own copy of every group-scoped
 * state volume, seeded with the group's prepared files.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = '/tmp/nanoclaw-test-session-scoped-state';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-scoped-state/data' };
});

import './index.js';
import { providerStateVolumePath, realizeProviderSpawnSurfaces, withSessionScopedState } from './realize.js';
import { getProviderHostContract } from './registry.js';

const GROUP = 'ag-spec';
const groupState = path.join(ROOT, 'data', 'v2-sessions', GROUP, '.claude-shared');
const sessionDirectory = path.join(ROOT, 'data', 'v2-sessions', GROUP, 'sess-task');
const sessionState = path.join(sessionDirectory, '.claude-shared');

async function realize(): Promise<void> {
  const contract = withSessionScopedState(getProviderHostContract('claude')!);
  await realizeProviderSpawnSurfaces(
    'claude',
    contract,
    GROUP,
    path.join(ROOT, 'groups', 'spec'),
    sessionDirectory,
    [],
    {
      legacyOverlay: async () => ({}),
      composeProjectDocument: async () => {},
    },
  );
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(groupState, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'groups', 'spec'), { recursive: true });
  fs.mkdirSync(sessionDirectory, { recursive: true });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('withSessionScopedState', () => {
  it('makes every group-scoped state volume session-scoped, and nothing else', () => {
    const contract = getProviderHostContract('claude')!;
    const scoped = withSessionScopedState(contract);
    expect(contract.stateVolumes.every((v) => v.scope === 'group')).toBe(true);
    expect(scoped.stateVolumes.map((v) => v.scope)).toEqual(contract.stateVolumes.map(() => 'session'));
    expect(scoped.stateVolumes.map((v) => ({ ...v, scope: 'group' }))).toEqual(contract.stateVolumes);
    expect(scoped.files).toBe(contract.files);
  });

  it('puts the volume under the session folder', () => {
    const volume = withSessionScopedState(getProviderHostContract('claude')!).stateVolumes[0];
    expect(providerStateVolumePath(volume, GROUP, sessionDirectory)).toBe(sessionState);
  });
});

describe('seeding a session-scoped volume', () => {
  it("starts the session's settings as the group's, not the declared default", async () => {
    fs.writeFileSync(path.join(groupState, 'settings.json'), '{"group": true}\n');
    await realize();
    expect(fs.readFileSync(path.join(sessionState, 'settings.json'), 'utf-8')).toBe('{"group": true}\n');
  });

  it('falls back to the declared content when the group has no copy', async () => {
    await realize();
    expect(JSON.parse(fs.readFileSync(path.join(sessionState, 'settings.json'), 'utf-8')).autoMemoryEnabled).toBe(
      false,
    );
  });

  it("leaves the session's own settings alone once they exist", async () => {
    fs.writeFileSync(path.join(groupState, 'settings.json'), '{"group": true}\n');
    fs.mkdirSync(sessionState, { recursive: true });
    fs.writeFileSync(path.join(sessionState, 'settings.json'), '{"mine": true}\n');
    await realize();
    expect(fs.readFileSync(path.join(sessionState, 'settings.json'), 'utf-8')).toBe('{"mine": true}\n');
  });

  it('refuses a name the container planted, and writes nothing through it', async () => {
    fs.writeFileSync(path.join(groupState, 'settings.json'), '{"group": true}\n');
    fs.mkdirSync(sessionState, { recursive: true });
    const target = path.join(ROOT, 'outside.json');
    fs.symlinkSync(target, path.join(sessionState, 'settings.json'));
    await realize();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(path.join(sessionState, 'settings.json')).isSymbolicLink()).toBe(true);
  });

  it("never touches the group's own state", async () => {
    fs.writeFileSync(path.join(groupState, 'settings.json'), '{"group": true}\n');
    await realize();
    expect(fs.readdirSync(groupState)).toEqual(['settings.json']);
  });
});
