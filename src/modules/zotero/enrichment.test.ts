/**
 * Abstract enrichment backlog and its runs (specs/zotero.allium
 * EnrichmentBacklogScheduled, EnrichmentTriggeredAfterSync, EnrichmentRun),
 * against a real central DB and real session folders.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-zotero-enrichment';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-zotero-enrichment/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-zotero-enrichment/groups',
  };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { ENRICHMENT_RUN_BUDGET_SECONDS, enrichmentBacklog, itemInBacklog, queueEnrichmentTask } from './sync.js';

const AG = 'ag-zotero';
const FOLDER = 'zot';
const MD_DIR = path.join(TEST_ROOT, 'groups', FOLDER, 'zotero-md');
const NOW = new Date('2026-10-11T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const ABSTRACT = 'A'.repeat(120);

function item(lookup?: string, abstract?: string): string {
  const fm = ['title: T', 'zoteroKey: K', ...(lookup ? [`abstract_lookup: ${lookup}`] : [])].join('\n');
  return `---\n${fm}\n---\n# T\n\nAuthor (2020)\n${abstract ? `\n${abstract}\n` : ''}`;
}

function writeItem(key: string, text: string): void {
  fs.mkdirSync(MD_DIR, { recursive: true });
  fs.writeFileSync(path.join(MD_DIR, `${key}.md`), text);
}

async function enrichTasks(): Promise<Array<{ id: string; content: string }>> {
  const session = (await getDb().get(
    'SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS NULL',
    AG,
  )) as { id: string } | undefined;
  if (!session) return [];
  const tasks = await withExistingMailboxSession(AG, session.id, (m) => m.listLiveTasks('pending'));
  return (tasks ?? []).filter((t) => t.id.startsWith('task-zotero-enrich-'));
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Zotero',
    folder: FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('itemInBacklog', () => {
  it('includes an item without an abstract or lookup record', () => {
    expect(itemInBacklog(item(), NOW)).toBe(true);
  });

  it('excludes an item with an abstract', () => {
    expect(itemInBacklog(item(undefined, ABSTRACT), NOW)).toBe(false);
  });

  it('excludes a not_found lookup within the retry interval, and includes one past it', () => {
    expect(itemInBacklog(item(`${daysAgo(179)} not_found`), NOW)).toBe(false);
    expect(itemInBacklog(item(`${daysAgo(181)} not_found`), NOW)).toBe(true);
  });

  it('keeps inconclusive lookups in the backlog', () => {
    expect(itemInBacklog(item(`${daysAgo(0)} inconclusive`), NOW)).toBe(true);
  });

  it('ignores a file without frontmatter', () => {
    expect(itemInBacklog('# just text\n', NOW)).toBe(false);
  });
});

describe('enrichmentBacklog', () => {
  it('lists backlog keys, optionally only among given keys', () => {
    writeItem('NEW', item());
    writeItem('DONE', item(undefined, ABSTRACT));
    writeItem('RECENT', item(`${daysAgo(3)} not_found`));
    writeItem('RETRY', item(`${daysAgo(3)} inconclusive`));
    expect(enrichmentBacklog(FOLDER, NOW).sort()).toEqual(['NEW', 'RETRY']);
    expect(enrichmentBacklog(FOLDER, NOW, ['DONE', 'NEW', 'MISSING'])).toEqual(['NEW']);
  });

  it('is empty when the folder does not exist', () => {
    expect(enrichmentBacklog('no-such-folder', NOW)).toEqual([]);
  });
});

describe('queueEnrichmentTask', () => {
  it('queues a budgeted script task that never wakes the agent', async () => {
    expect(await queueEnrichmentTask(FOLDER)).toBe(true);
    const [task] = await enrichTasks();
    const content = JSON.parse(task.content) as { script: string };
    expect(content.script).toContain('node /app/tools/zotero-abstracts.mjs --dir /workspace/agent/zotero-md');
    expect(content.script).toContain(`--budget-seconds ${ENRICHMENT_RUN_BUDGET_SECONDS}`);
    expect(content.script).toContain('"wakeAgent":false');
    expect(ENRICHMENT_RUN_BUDGET_SECONDS).toBeLessThan(30); // container pre-task script timeout
  });

  it('does not queue a second run while one is still waiting', async () => {
    expect(await queueEnrichmentTask(FOLDER)).toBe(true);
    expect(await queueEnrichmentTask(FOLDER)).toBe(false);
    expect(await enrichTasks()).toHaveLength(1);
  });

  it('does nothing for an unknown group', async () => {
    expect(await queueEnrichmentTask('nope')).toBe(false);
  });
});
