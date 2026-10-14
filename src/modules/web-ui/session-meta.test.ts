/**
 * Every session's container gets /workspace/nanoclaw_meta.json, whatever
 * created the session. It was written from the chat router's session-created
 * hook only, so a task session's agent had no get_file_url (2026-10-14: the
 * synthesis scan sent a container path instead of a link).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-ui-meta-'));
vi.mock('../../session-manager.js', () => ({
  sessionDir: (groupId: string, sessionId: string) => path.join(root, groupId, sessionId),
}));

import { withSessionContributions } from '../../container-runner.js';
import type { AgentGroup, Session } from '../../types.js';
import './index.js';

const group = { id: 'ag-1', folder: 'dm-with-someone' } as AgentGroup;
const session = { id: 'sess-task', agent_group_id: 'ag-1', thread_id: null } as Session;
const metaPath = path.join(root, 'ag-1', 'sess-task', 'nanoclaw_meta.json');

describe('web-ui session metadata', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    vi.stubEnv('WEB_UI_BASE_URL', 'https://example.test:8443/');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(path.join(root, 'ag-1'), { recursive: true, force: true });
  });

  it('is written when a session container is spawned', async () => {
    await withSessionContributions({}, { agentGroup: group, session });
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toEqual({
      webUiBaseUrl: 'https://example.test:8443',
      groupFolder: 'dm-with-someone',
    });
  });

  it('adds no mount or env to the session', async () => {
    const contribution = await withSessionContributions({}, { agentGroup: group, session });
    expect(contribution.mounts ?? []).toEqual([]);
    expect(contribution.env ?? {}).toEqual({});
  });
});
