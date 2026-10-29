/**
 * zotero-md/ belongs to the host's sync and enrichment (zotero.allium): the
 * synced group's containers get it read-only, over the writable group folder.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  groups: '',
  contributors: [] as Array<(ctx: { agentGroup: { id: string; folder: string } }) => unknown>,
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get GROUPS_DIR() {
    return h.groups;
  },
}));
vi.mock('./config.js', () => ({ ZOTERO_GROUP_FOLDER: 'lib', ZOTERO_POLL_INTERVAL: 3_600_000 }));
vi.mock('../../container-runner.js', () => ({
  registerSessionContributor: (c: (ctx: { agentGroup: { id: string; folder: string } }) => unknown) =>
    h.contributors.push(c),
}));
vi.mock('./monitor.js', () => ({ startZoteroMonitor: vi.fn() }));

h.groups = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-mount-')));
await import('./index.js');

describe('zotero-md mount', () => {
  it("gives the synced group's containers zotero-md read-only", () => {
    const out = h.contributors[0]({ agentGroup: { id: 'ag-lib', folder: 'lib' } });
    expect(out).toEqual({
      mounts: [
        {
          hostPath: path.join(h.groups, 'lib', 'zotero-md'),
          containerPath: '/workspace/agent/zotero-md',
          readonly: true,
        },
      ],
    });
    expect(fs.existsSync(path.join(h.groups, 'lib', 'zotero-md'))).toBe(true);
  });

  it('adds nothing for any other group', () => {
    expect(h.contributors[0]({ agentGroup: { id: 'ag-x', folder: 'other' } })).toBeUndefined();
  });
});
