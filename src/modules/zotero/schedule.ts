import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE, ZOTERO_POLL_INTERVAL } from '../../config.js';
import type { ZoteroSyncState } from './db.js';

/**
 * Compute the next check time, advancing from state.next_check (not from now)
 * so the schedule stays regular even when a sync is delayed. Missed intervals
 * are skipped forward until the next future slot.
 */
export function computeNextZoteroCheck(
  state: Pick<ZoteroSyncState, 'schedule_type' | 'schedule_value' | 'next_check'>,
  from?: Date,
): string {
  const now = (from ?? new Date()).getTime();

  if (state.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(state.schedule_value, { tz: TIMEZONE });
    return interval.next().toISOString() ?? new Date(now + ZOTERO_POLL_INTERVAL).toISOString();
  }

  // interval — advance from the last scheduled check, skipping missed windows
  const ms = parseInt(state.schedule_value, 10);
  let next = new Date(state.next_check ?? new Date(now - ms).toISOString()).getTime() + ms;
  while (next <= now) {
    next += ms;
  }
  return new Date(next).toISOString();
}
