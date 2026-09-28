/**
 * Zotero library sync — host-side wiring.
 *
 * Polls a Zotero library and materializes it into the configured agent
 * group's folder as markdown, where the memory indexer can pick it up.
 *
 * Disabled unless ZOTERO_GROUP_FOLDER names a group folder — the monitor
 * itself no-ops in that case, and registering through the lifecycle keeps the
 * decision in one place rather than in `src/index.ts`.
 */
import { registerSessionContributor } from '../../container-runner.js';
import { readEnvFile } from '../../env.js';
import { onHostStart } from '../../host-lifecycle.js';

import { ZOTERO_GROUP_FOLDER } from './config.js';

import { startZoteroMonitor } from './monitor.js';

onHostStart(() => {
  startZoteroMonitor();
});

// The sync itself runs in the container (container/tools/zotero-sync.mjs) and
// calls the Zotero API directly, so the target group's sessions carry the
// key. Scoped to that one group: nothing else calls the API.
registerSessionContributor(({ agentGroup }) => {
  if (!ZOTERO_GROUP_FOLDER || agentGroup.folder !== ZOTERO_GROUP_FOLDER) return undefined;
  const env = readEnvFile(['ZOTERO_API_KEY', 'ZOTERO_USER_ID']);
  if (!env.ZOTERO_API_KEY || !env.ZOTERO_USER_ID) return undefined;
  return { env: { ZOTERO_API_KEY: env.ZOTERO_API_KEY, ZOTERO_USER_ID: env.ZOTERO_USER_ID } };
});

export { startZoteroMonitor, _resetZoteroMonitorForTests } from './monitor.js';
