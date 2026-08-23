/**
 * Zotero settings.
 *
 * Module-local rather than in `src/config.ts`: these mean nothing to an
 * install that does not sync a library, and a core config file that grew a
 * field per optional module would make every module a patch of it.
 */
import { readEnvFile } from '../../env.js';

const SETTINGS = ['ZOTERO_GROUP_FOLDER', 'ZOTERO_POLL_INTERVAL'] as const;

function setting(key: (typeof SETTINGS)[number]): string {
  return process.env[key]?.trim() || readEnvFile([...SETTINGS])[key]?.trim() || '';
}

/** Which agent-group folder the library syncs into. Empty disables the module. */
export const ZOTERO_GROUP_FOLDER: string = setting('ZOTERO_GROUP_FOLDER');

/** How often to poll the library for changes. Default 1h. */
export const ZOTERO_POLL_INTERVAL: number = parseInt(setting('ZOTERO_POLL_INTERVAL') || '3600000', 10) || 3600000;
