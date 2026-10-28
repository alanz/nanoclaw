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
  initMemoryManagers,
  isMemoryGroupExcluded,
} from '../../memory/manager.js';
import '../../db/migrations/module-memory.js';
import './search-action.js';

const SETTINGS = ['MEMORY_SEARCH_GEMINI_API_KEY', 'MEMORY_SEARCH_MODEL', 'MEMORY_SEARCH_GROUPS'] as const;

function setting(key: (typeof SETTINGS)[number]): string | undefined {
  return process.env[key] ?? readEnvFile([...SETTINGS])[key];
}

onHostStart(async () => {
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
});

onHostShutdown(() => closeAllMemoryManagers());

// Search goes to the host (search-action.ts); get, list and the keyword-only
// fallback read the index directly via bun:sqlite, so the container needs the
// group's index dir mounted, and NANOCLAW_MEMORY_ENABLED to register the tools.
// Keyed on the host running a manager for the group — it is allowlisted in
// MEMORY_SEARCH_GROUPS and an embedding key is set — not on the index dir
// existing: a group taken off the list (or an install whose key was removed)
// keeps its old dir, and was handed tools over a frozen index the host no
// longer searches. A directory mount, not the index file: Apple Container
// binds directories only.
registerSessionContributor(({ agentGroup }) => {
  if (isMemoryGroupExcluded(agentGroup.id)) return undefined;
  if (!getMemoryManager(agentGroup.id)) return undefined;
  const indexDir = path.join(DATA_DIR, 'v2-memory', agentGroup.id);
  if (!fs.existsSync(indexDir)) return undefined;
  return {
    mounts: [{ hostPath: indexDir, containerPath: '/workspace/memory', readonly: true }],
    env: { NANOCLAW_MEMORY_ENABLED: '1' },
  };
});
