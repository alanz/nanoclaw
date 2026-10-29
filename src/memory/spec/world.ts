/**
 * A small install for the activation and access obligations: real central DB
 * (migrations), real specialists module (exclusion + memory_group_for
 * delegate), real memory module host start, session contributor and search
 * action, under a temporary DATA_DIR / GROUPS_DIR. The importing test file
 * mocks config.js (to those dirs), env.js (no real .env), the embedding
 * provider, the rate limiter, the watcher, specialists' invocation.js and the
 * session mailbox write.
 *
 *   ag-main  folder main     ordinary group (the default allowlist)
 *   ag-side  folder side     ordinary group, not allowlisted by default
 *   ag-coder folder coder    specialist
 *   ag-mem   folder memprov  memory-provider specialist, mounts main's folder as `main`
 *
 * Sessions: sess-main, sess-side, sess-coder (task-coder, root, serving
 * ag-main) and sess-mem (task-mem, a sub-task of task-coder).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { withSessionContributions } from '../../container-runner.js';
import { createAgentGroup, getAgentGroup } from '../../db/agent-groups.js';
import { getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession, getSession } from '../../db/sessions.js';
import { getHostStartCallbacks, type HostStartCallback } from '../../host-lifecycle.js';
import { createSpecialist, createTask } from '../../modules/specialists/db.js';
import type { SpecialistTask } from '../../modules/specialists/types.js';
import { closeAllMemoryManagers, getMemoryManager } from '../manager.js';
import { settled } from './fixtures.js';

export const GROUPS = {
  main: { id: 'ag-main', folder: 'main' },
  side: { id: 'ag-side', folder: 'side' },
  coder: { id: 'ag-coder', folder: 'coder' },
  mem: { id: 'ag-mem', folder: 'memprov' },
} as const;
export type GroupKey = keyof typeof GROUPS;

export const SESSIONS = {
  main: { id: 'sess-main', agent_group_id: 'ag-main', thread_id: null },
  side: { id: 'sess-side', agent_group_id: 'ag-side', thread_id: null },
  coder: { id: 'sess-coder', agent_group_id: 'ag-coder', thread_id: 'task-coder' },
  mem: { id: 'sess-mem', agent_group_id: 'ag-mem', thread_id: 'task-mem' },
} as const;

/** Each group's one memory file, as written by resetFiles(). */
export const FILES: Record<GroupKey, { rel: string; content: string }> = {
  main: { rel: 'memory/a.md', content: '# Main\n\nAardvarks live in main.\n' },
  side: { rel: 'memory/s.md', content: '# Side\n\nAardvarks live in side too.\n' },
  coder: { rel: 'memory/c.md', content: '# Coder\n\nAardvarks in a specialist scratch file.\n' },
  mem: { rel: 'memory/m.md', content: '# Provider\n\nAardvarks in the provider scratch file.\n' },
};

export const repoPath = (k: GroupKey, rel = FILES[k].rel) => `groups/${GROUPS[k].folder}/${rel}`;
export const diskPath = (k: GroupKey, rel = FILES[k].rel) => path.join(GROUPS_DIR, GROUPS[k].folder, rel);
export const indexDir = (k: GroupKey) => path.join(DATA_DIR, 'v2-memory', GROUPS[k].id);
export const indexFile = (k: GroupKey) => path.join(indexDir(k), 'index.db');

const now = () => new Date().toISOString();

function task(fields: Partial<SpecialistTask> & { id: string; specialist_group_id: string }): SpecialistTask {
  return {
    prompt: 'p',
    requester_group_id: null,
    requester_task_id: null,
    requester_session_id: 'sess-main',
    depth: 0,
    chain_delegation_count: 1,
    ancestor_group_ids: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    dispatched_at: now(),
    restart_attempt_count: 0,
    closed_at: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    pending_sub_task_id: null,
    committed_files: null,
    ...fields,
  };
}

let memoryStart: HostStartCallback | null = null;

/** Build the install, then load the memory module (its host start is captured). */
export async function buildWorld(): Promise<void> {
  await runMigrations(await initTestDb());
  for (const [key, g] of Object.entries(GROUPS)) {
    await createAgentGroup({ id: g.id, name: g.id, folder: g.folder, agent_provider: null, created_at: now() });
    const mounts =
      key === 'mem' ? [{ hostPath: path.join(GROUPS_DIR, 'main'), containerPath: 'main', readonly: true }] : [];
    await getDb().run(
      `INSERT INTO container_configs (agent_group_id, skills, mcp_servers, packages_apt, packages_npm, additional_mounts, updated_at)
       VALUES (?, '[]', '{}', '[]', '[]', ?, ?)`,
      g.id,
      JSON.stringify(mounts),
      now(),
    );
  }
  for (const key of ['coder', 'mem'] as const) {
    await createSpecialist({
      agent_group_id: GROUPS[key].id,
      is_memory_provider: key === 'mem' ? 1 : 0,
      last_turn_sub_notice: null,
      last_turn_parent_notice: null,
      created_at: now(),
    });
  }
  for (const s of Object.values(SESSIONS)) {
    await createSession({
      id: s.id,
      agent_group_id: s.agent_group_id,
      messaging_group_id: null,
      thread_id: s.thread_id,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      processing_state: 'idle',
      last_active: now(),
      created_at: now(),
    } as never);
  }

  await createTask(task({ id: 'task-coder', specialist_group_id: 'ag-coder', requester_group_id: 'ag-main' }));
  await createTask(
    task({
      id: 'task-mem',
      specialist_group_id: 'ag-mem',
      requester_task_id: 'task-coder',
      requester_session_id: 'sess-coder',
      depth: 1,
    }),
  );
  const before = getHostStartCallbacks().length;
  await import('../../modules/memory/index.js');
  const added = getHostStartCallbacks().slice(before);
  if (added.length !== 1) throw new Error(`expected the memory module to add one host start, got ${added.length}`);
  memoryStart = added[0]!;
}

/** Every group's memory file as written, and no index anywhere. */
export async function resetFiles(): Promise<void> {
  await closeAllMemoryManagers();
  fs.rmSync(path.join(DATA_DIR, 'v2-memory'), { recursive: true, force: true });
  fs.rmSync(GROUPS_DIR, { recursive: true, force: true });
  for (const k of Object.keys(GROUPS) as GroupKey[]) {
    fs.mkdirSync(path.dirname(diskPath(k)), { recursive: true });
    fs.writeFileSync(diskPath(k), FILES[k].content);
  }
}

const ENV = {
  key: 'MEMORY_SEARCH_GEMINI_API_KEY',
  groups: 'MEMORY_SEARCH_GROUPS',
  model: 'MEMORY_SEARCH_MODEL',
} as const;

/**
 * A host start of the memory module with these settings (the previous host's
 * managers closed first, as a restart does), waiting for the first syncs.
 */
export async function startMemory(settings: { key?: string; groups?: string; model?: string }): Promise<void> {
  await closeAllMemoryManagers();
  for (const [name, variable] of Object.entries(ENV)) {
    const value = settings[name as keyof typeof settings];
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
  }
  await memoryStart!({} as never);
  for (const g of Object.values(GROUPS)) {
    const m = getMemoryManager(g.id);
    if (m) await settled(m);
  }
}

export function clearSettings(): void {
  for (const variable of Object.values(ENV)) delete process.env[variable];
}

/** The rows of a group's index, or null when it has none. */
export function indexRows(k: GroupKey): {
  files: Array<{ path: string; hash: string }>;
  chunks: number;
  fingerprint: string | null;
} | null {
  if (!fs.existsSync(indexFile(k))) return null;
  const db = new Database(indexFile(k), { readonly: true });
  try {
    return {
      files: db.prepare('SELECT path, hash FROM files ORDER BY path').all() as Array<{ path: string; hash: string }>,
      chunks: (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n,
      fingerprint:
        (db.prepare("SELECT value FROM meta WHERE key = 'index_fingerprint_v2'").get() as { value: string } | undefined)
          ?.value ?? null,
    };
  } finally {
    db.close();
  }
}

/** What the session's container gets from every registered session contributor. */
export async function contribution(k: keyof typeof SESSIONS) {
  const session = await getSession(SESSIONS[k].id);
  const agentGroup = await getAgentGroup(SESSIONS[k].agent_group_id);
  const c = await withSessionContributions({}, { session: session!, agentGroup: agentGroup! });
  return {
    memoryMount: (c.mounts ?? []).find((m) => m.containerPath === '/workspace/memory'),
    env: c.env ?? {},
  };
}
