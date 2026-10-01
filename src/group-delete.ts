/**
 * Group-deletion steps contributed by modules.
 *
 * `ncl groups delete` removes an agent group and every row that references it
 * in one transaction, FK-ordered. It knows the core tables. A module that adds
 * a table referencing `agent_groups` or `sessions` must remove its own rows
 * first, or the core delete fails on a foreign key and rolls back — which made
 * most real groups undeletable once they had indexed memory, Zotero state or
 * specialist history.
 *
 * Each module registers the step for its own tables, so the delete never has
 * to know which modules are installed. Steps run inside the delete's
 * transaction, before any core row is removed, in registration order; a step
 * that throws rolls the whole delete back.
 */
import { hasTable } from './db/connection.js';
import type { DbDriver } from './db/driver.js';

export interface GroupDeleteStep {
  /** Reported in the delete's `removed` counts. */
  name: string;
  /** Remove this module's rows for the group. Returns the number of rows removed. */
  run(db: DbDriver, agentGroupId: string): Promise<number>;
}

const steps: GroupDeleteStep[] = [];

export function registerGroupDeleteStep(step: GroupDeleteStep): void {
  if (steps.some((s) => s.name === step.name)) {
    throw new Error(`Group delete step already registered: ${step.name}`);
  }
  steps.push(step);
}

/** Run every registered step for one group. Call inside the delete's transaction. */
export async function runGroupDeleteSteps(db: DbDriver, agentGroupId: string): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const step of steps) removed[step.name] = await step.run(db, agentGroupId);
  return removed;
}

/**
 * Upstream's agent-to-agent module adds `agent_message_policies`, which
 * references both ends of a pair by agent group, and the core delete does not
 * remove it. Registered here rather than in that module so the fork does not
 * patch it; harmless where the table is absent.
 */
registerGroupDeleteStep({
  name: 'agent_message_policies',
  async run(db, id) {
    if (!(await hasTable(db, 'agent_message_policies'))) return 0;
    return (
      await db.run('DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?', id, id)
    ).changes;
  },
});
