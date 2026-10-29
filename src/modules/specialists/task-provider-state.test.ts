/**
 * A specialist task's provider state is its own: the module asks core for
 * session-scoped state for every specialist session, and clears all of it but
 * the transcripts when the task's session closes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ data: '' }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return dirs.data;
    },
  };
});
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn(() => false),
}));
vi.mock('../../db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/sessions.js')>()),
  updateSession: vi.fn(async () => undefined),
}));
vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  withExistingMailboxSession: vi.fn(async () => undefined),
}));

import type { Session } from '../../types.js';
import { closeSpecialistSession } from './session-helpers.js';

const session = { id: 'sess-spec-1', agent_group_id: 'ag-rsrch' } as Session;

beforeEach(() => {
  dirs.data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-state-')));
});
afterEach(() => {
  fs.rmSync(dirs.data, { recursive: true, force: true });
});

describe('closing a task session', () => {
  it("clears the task's own provider state but keeps its transcripts", async () => {
    const state = path.join(dirs.data, 'v2-sessions', 'ag-rsrch', 'sess-spec-1', '.claude-shared');
    fs.mkdirSync(path.join(state, 'projects', '-workspace-agent'), { recursive: true });
    fs.writeFileSync(path.join(state, 'projects', '-workspace-agent', 'c.jsonl'), '{}\n');
    fs.writeFileSync(path.join(state, 'settings.json'), '{}');
    fs.mkdirSync(path.join(state, 'shell-snapshots'));
    fs.mkdirSync(path.join(state, 'skills'));
    fs.symlinkSync('/nowhere', path.join(state, 'skills', 'agent-browser'));

    await closeSpecialistSession(session);

    expect(fs.readdirSync(state)).toEqual(['projects']);
    expect(fs.existsSync(path.join(state, 'projects', '-workspace-agent', 'c.jsonl'))).toBe(true);
  });

  it("leaves the group's shared state alone", async () => {
    const shared = path.join(dirs.data, 'v2-sessions', 'ag-rsrch', '.claude-shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'settings.json'), '{}');

    await closeSpecialistSession(session);

    expect(fs.readdirSync(shared)).toEqual(['settings.json']);
  });

  it('is quiet for a task that never started', async () => {
    await expect(closeSpecialistSession(session)).resolves.toBeUndefined();
  });
});
