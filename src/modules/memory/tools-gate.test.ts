/**
 * The memory tools and index mount reach a container only while the host
 * runs a manager for its group (allowlisted, embedding key set). An index
 * dir left from before is not enough: the host no longer searches or updates
 * it (specs/memory.allium MemoryMcpTools, memory_search_groups).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dataDir: '',
  contributors: [] as Array<(ctx: { agentGroup: { id: string } }) => unknown>,
  live: new Set<string>(),
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get DATA_DIR() {
    return h.dataDir;
  },
}));
vi.mock('../../container-runner.js', () => ({
  registerSessionContributor: (c: (ctx: { agentGroup: { id: string } }) => unknown) => h.contributors.push(c),
}));
vi.mock('../../memory/manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/manager.js')>()),
  getMemoryManager: (id: string) => (h.live.has(id) ? {} : undefined),
}));

import './index.js';

beforeEach(() => {
  h.dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tools-gate-')));
  h.live.clear();
});
afterEach(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));

const contribute = (id: string) => h.contributors[0]({ agentGroup: { id } });

describe('memory tools gate', () => {
  it('gives the tools to a group the host indexes', () => {
    fs.mkdirSync(path.join(h.dataDir, 'v2-memory', 'ag-1'), { recursive: true });
    h.live.add('ag-1');
    expect(contribute('ag-1')).toMatchObject({ env: { NANOCLAW_MEMORY_ENABLED: '1' } });
  });

  it('withholds them from a group with only a leftover index dir', () => {
    fs.mkdirSync(path.join(h.dataDir, 'v2-memory', 'ag-2'), { recursive: true });
    expect(contribute('ag-2')).toBeUndefined();
  });
});
