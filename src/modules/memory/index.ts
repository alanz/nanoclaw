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
import { GROUPS_DIR, DATA_DIR } from '../../config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { closeAllMemoryManagers, initMemoryManagers } from '../../memory/manager.js';

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
