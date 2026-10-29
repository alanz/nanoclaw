import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import { ZOTERO_POLL_INTERVAL } from './config.js';
import type { ZoteroSyncState } from './db.js';

type Schedule = Pick<ZoteroSyncState, 'schedule_type' | 'schedule_value'>;

const MIN_INTERVAL_MS = 60_000;

/**
 * The schedule to run on. zotero.allium: a SyncState schedule is cron or
 * interval ("once is not valid"). The column is plain TEXT, so only a hand
 * edit can put anything else there, but a bad row must not hammer or stall
 * the monitor: a `once` timestamp read as an interval is ~2 s, and a
 * non-numeric one throws on every tick. Anything unusable — an unknown type,
 * an unparseable cron expression, an interval under a minute — falls back to
 * the default interval.
 */
function usableSchedule(state: Schedule): { type: 'interval' | 'cron'; value: string } {
  const type = state.schedule_type as string;
  const value = state.schedule_value;
  if (type === 'cron') {
    try {
      CronExpressionParser.parse(value, { tz: TIMEZONE });
      return { type, value };
    } catch {
      // unparseable: fall back below
    }
  } else if (type === 'interval' && /^\d+$/.test(value) && Number(value) >= MIN_INTERVAL_MS) {
    return { type, value };
  }
  log.warn('Zotero: unusable sync schedule, using the default interval', {
    scheduleType: type,
    scheduleValue: value,
    defaultIntervalMs: ZOTERO_POLL_INTERVAL,
  });
  return { type: 'interval', value: String(ZOTERO_POLL_INTERVAL) };
}

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
  const schedule = usableSchedule(state);

  if (schedule.type === 'cron') {
    const interval = CronExpressionParser.parse(schedule.value, { tz: TIMEZONE });
    return interval.next().toISOString() ?? new Date(now + ZOTERO_POLL_INTERVAL).toISOString();
  }

  // interval — advance from the last scheduled check, skipping missed windows
  const ms = parseInt(schedule.value, 10);
  let next = new Date(state.next_check ?? new Date(now - ms).toISOString()).getTime() + ms;
  while (next <= now) {
    next += ms;
  }
  return new Date(next).toISOString();
}
