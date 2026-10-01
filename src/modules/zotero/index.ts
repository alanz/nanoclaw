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
import { proxiedService } from '../../gateway-providers/native-proxy.js';
import { onHostStart } from '../../host-lifecycle.js';

import { ZOTERO_GROUP_FOLDER } from './config.js';

import { startZoteroMonitor } from './monitor.js';
import './group-delete.js';

onHostStart(() => {
  startZoteroMonitor();
});

// The sync itself runs in the container (container/tools/zotero-sync.mjs) and
// calls the Zotero API, through the native proxy's Zotero route: the container
// holds the install placeholder, the proxy attaches the real key. Scoped to
// the target group — nothing else calls the API. The user id is an
// identifier, not a credential, so it travels as plain env.
registerSessionContributor(({ agentGroup }) => {
  if (!ZOTERO_GROUP_FOLDER || agentGroup.folder !== ZOTERO_GROUP_FOLDER) return undefined;
  const userId = readEnvFile(['ZOTERO_USER_ID']).ZOTERO_USER_ID;
  const zotero = proxiedService('zotero');
  if (!userId || !zotero) return undefined;
  return { env: { ZOTERO_USER_ID: userId, ZOTERO_API_KEY: zotero.token, ZOTERO_API_BASE: zotero.baseUrl } };
});
