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
import { onHostStart } from '../../host-lifecycle.js';

import { startZoteroMonitor } from './monitor.js';

onHostStart(() => {
  startZoteroMonitor();
});

export { startZoteroMonitor, _resetZoteroMonitorForTests } from './monitor.js';
