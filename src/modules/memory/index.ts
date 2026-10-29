/**
 * Memory search — host-side lifecycle.
 *
 * The indexer itself lives in `src/memory/`; this is only its wiring. It sits
 * behind the host lifecycle registry rather than in `src/index.ts` so that an
 * install without an embedding key never constructs a watcher, and installing
 * the feature stays one appended import.
 *
 * Disabled unless MEMORY_SEARCH_GEMINI_API_KEY is set. MEMORY_SEARCH_GROUPS
 * narrows which agent-group folders are indexed (default: `main`), because
 * embedding quota is finite and most groups' memory is never searched.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, DATA_DIR } from '../../config.js';
import { registerSessionContributor } from '../../container-runner.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import {
  closeAllMemoryManagers,
  getMemoryManager,
  initMemoryManagerForGroup,
  initMemoryManagers,
  memoryAccessFor,
} from '../../memory/manager.js';
import '../../db/migrations/module-memory.js';
import './search-action.js';

const SETTINGS = ['MEMORY_SEARCH_GEMINI_API_KEY', 'MEMORY_SEARCH_MODEL', 'MEMORY_SEARCH_GROUPS'] as const;

function setting(key: (typeof SETTINGS)[number]): string | undefined {
  return process.env[key] ?? readEnvFile([...SETTINGS])[key];
}

/** What host start found; memory is off (nothing to adopt) while unset. */
let active: { apiKey: string; model?: string; allowedFolders: Set<string> } | undefined;
let adoptTimer: ReturnType<typeof setInterval> | undefined;

const ADOPT_INTERVAL_MS = 60_000;

/**
 * An allowlisted group created while the host runs (/init-first-agent, `ncl
 * groups create`) gets its manager — an index, and the memory tools — without
 * a restart (specs/memory.allium FileDiscovered, MemoryIndexCreated,
 * MemoryMcpTools depend on nothing else). Run on a timer and before a session
 * of a group without one starts; core has no group-created hook.
 */
async function adoptNewGroups(): Promise<void> {
  if (!active) return;
  for (const g of await getAllAgentGroups()) {
    if (getMemoryManager(g.id) || !active.allowedFolders.has(g.folder)) continue;
    await initMemoryManagerForGroup({
      dataDir: DATA_DIR,
      groupsDir: GROUPS_DIR,
      apiKey: active.apiKey,
      model: active.model,
      group: { id: g.id, folder: g.folder },
      allowedFolders: active.allowedFolders,
    });
    if (getMemoryManager(g.id)) log.info('Memory index: new group indexed', { groupId: g.id, folder: g.folder });
  }
}

onHostStart(async () => {
  // Nothing from an earlier start carries over: with no key, nothing adopts.
  if (adoptTimer) clearInterval(adoptTimer);
  adoptTimer = undefined;
  active = undefined;

  const apiKey = setting('MEMORY_SEARCH_GEMINI_API_KEY') ?? '';
  if (!apiKey) {
    log.info('Memory search disabled: MEMORY_SEARCH_GEMINI_API_KEY not set');
    return;
  }

  const allowedFolders = new Set(
    (setting('MEMORY_SEARCH_GROUPS') ?? 'main')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
  );

  const groups = await getAllAgentGroups();
  await initMemoryManagers({
    dataDir: DATA_DIR,
    groupsDir: GROUPS_DIR,
    apiKey,
    model: setting('MEMORY_SEARCH_MODEL'),
    groups: groups.map((g) => ({ id: g.id, folder: g.folder })),
    allowedFolders,
  });
  log.info('Memory managers initialized', { groups: groups.length, indexed: allowedFolders.size });

  active = { apiKey, model: setting('MEMORY_SEARCH_MODEL'), allowedFolders };
  adoptTimer = setInterval(() => {
    adoptNewGroups().catch((err) => log.warn('Memory: adopting new groups failed', { err }));
  }, ADOPT_INTERVAL_MS);
  adoptTimer.unref();
});

onHostShutdown(() => {
  if (adoptTimer) clearInterval(adoptTimer);
  adoptTimer = undefined;
  active = undefined;
  return closeAllMemoryManagers();
});

// Search goes to the host (search-action.ts); get, list and the keyword-only
// fallback read the index directly via bun:sqlite, so the container needs the
// group's index dir mounted, and NANOCLAW_MEMORY_ENABLED to register the tools.
// The group is the one the session may read (memoryAccessFor: its own, or for
// a memory-provider specialist the group its task serves). Keyed on the host
// running a manager for that group — it is allowlisted in
// MEMORY_SEARCH_GROUPS and an embedding key is set — not on the index dir
// existing: a group taken off the list (or an install whose key was removed)
// keeps its old dir, and was handed tools over a frozen index the host no
// longer searches. A directory mount, not the index file: Apple Container
// binds directories only.
registerSessionContributor(async ({ session }) => {
  const access = await memoryAccessFor(session);
  if (!access) return undefined;
  if (!getMemoryManager(access.groupId)) await adoptNewGroups();
  if (!getMemoryManager(access.groupId)) return undefined;
  const indexDir = path.join(DATA_DIR, 'v2-memory', access.groupId);
  if (!fs.existsSync(indexDir)) return undefined;
  return {
    mounts: [{ hostPath: indexDir, containerPath: '/workspace/memory', readonly: true }],
    // Where the indexed group's files are in this container: its own
    // workspace, or (a memory provider) the read-only mount of the group it serves.
    env: { NANOCLAW_MEMORY_ENABLED: '1', NANOCLAW_MEMORY_WORKSPACE: access.workspacePath },
  };
});
