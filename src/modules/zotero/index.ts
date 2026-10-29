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
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { registerSessionContributor } from '../../container-runner.js';
import { onHostStart } from '../../host-lifecycle.js';
import { registerMemoryWorkspaceDir } from '../../memory/workspace-dirs.js';

import { ZOTERO_GROUP_FOLDER } from './config.js';

import { startZoteroMonitor } from './monitor.js';
import './group-delete.js';
import './cli.js';

onHostStart(() => {
  startZoteroMonitor();
});

// The library's item files are searchable from memory_search as source
// `zotero` (specs/memory.allium) — only in the group the library syncs into.
registerMemoryWorkspaceDir({
  subdir: 'zotero-md',
  source: 'zotero',
  appliesTo: (folder) => !!ZOTERO_GROUP_FOLDER && folder === ZOTERO_GROUP_FOLDER,
});

// zotero-md/ belongs to the host's sync and enrichment (sync.ts), which are
// its only writers: the group's containers get it read-only, mounted over the
// writable group folder at the path agents already use. The Zotero API key
// stays on the host.
registerSessionContributor(({ agentGroup }) => {
  if (!ZOTERO_GROUP_FOLDER || agentGroup.folder !== ZOTERO_GROUP_FOLDER) return undefined;
  const dir = path.join(GROUPS_DIR, agentGroup.folder, 'zotero-md');
  fs.mkdirSync(dir, { recursive: true });
  return { mounts: [{ hostPath: dir, containerPath: '/workspace/agent/zotero-md', readonly: true }] };
});
