/**
 * `ncl zotero retry-abstracts` — zotero.allium EnrichmentTriggeredOnRequest.
 *
 * Item files are written only by the host (agents mount zotero-md read-only),
 * so a user's "try those abstracts again" reaches the host as a command the
 * main agent can issue: forget every not_found record and run one pass now;
 * the hourly passes do the rest.
 */
import { registerResource } from '../../cli/crud.js';
import { ZOTERO_GROUP_FOLDER } from './config.js';
import { runEnrichment } from './sync.js';

registerResource({
  name: 'zotero',
  plural: 'zotero',
  table: 'zotero_sync_state',
  description: 'Zotero library sync state (one row). The sync and abstract enrichment run on the host.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'number', description: 'Always 1: the sync state is a singleton.' },
    { name: 'last_version', type: 'number', description: 'Zotero library version last synced.' },
    { name: 'total_items', type: 'number', description: 'Items in the library at the last sync.' },
    { name: 'last_sync', type: 'string', description: 'When the last sync ran (ISO 8601).' },
    { name: 'next_check', type: 'string', description: 'When the next version check is due (ISO 8601).' },
  ],
  operations: { list: 'open' },
  customOperations: {
    'retry-abstracts': {
      access: 'open',
      description:
        'Look up abstracts again for items whose earlier lookup found nothing: forgets every not_found record and runs one enrichment pass now (hourly passes continue). Prints the pass counts.',
      handler: async () => {
        if (!ZOTERO_GROUP_FOLDER) throw new Error('Zotero sync is not configured (ZOTERO_GROUP_FOLDER unset)');
        const result = await runEnrichment(ZOTERO_GROUP_FOLDER, { retryNotFound: true });
        if (result === null) throw new Error('the enrichment pass failed; see the host log');
        return result;
      },
    },
  },
});
