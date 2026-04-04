/**
 * Tests for the OrchestrationCycle timeout poller (CycleTimedOut rule).
 * Implementation: src/index.ts — startCycleTimeoutPoller / _resetCycleTimeoutPollerForTest
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getMessagesSince,
  storeChatMetadata,
} from './db.js';
import { CYCLE_TIMEOUT } from './config.js';
import {
  _getPendingCyclesForTest,
  _resetCycleTimeoutPollerForTest,
  _setRegisteredGroups,
  startCycleTimeoutPoller,
} from './index.js';

const MAIN_JID = 'main@g.us';
const SUB_FOLDER = 'sub-group';

beforeEach(() => {
  _initTestDatabase();
  _resetCycleTimeoutPollerForTest();
  storeChatMetadata(
    MAIN_JID,
    new Date().toISOString(),
    'Main',
    undefined,
    true,
  );
  _setRegisteredGroups({
    [MAIN_JID]: {
      name: 'Main',
      folder: 'main',
      trigger: '',
      added_at: '',
      isMain: true,
    },
  });
});

afterEach(() => {
  _resetCycleTimeoutPollerForTest();
});

describe('pendingCycles tracking', () => {
  it('starts empty after reset', () => {
    expect(Object.keys(_getPendingCyclesForTest())).toHaveLength(0);
  });

  it('reset clears manually-inserted entries', () => {
    _getPendingCyclesForTest()[SUB_FOLDER] = {
      taskId: 'task-1',
      delegatedAt: Date.now(),
    };
    _resetCycleTimeoutPollerForTest();
    expect(Object.keys(_getPendingCyclesForTest())).toHaveLength(0);
  });
});

describe('startCycleTimeoutPoller', () => {
  it('injects a timeout notice for an overdue cycle and removes the entry', async () => {
    _getPendingCyclesForTest()[SUB_FOLDER] = {
      taskId: 'task-overdue',
      delegatedAt: Date.now() - CYCLE_TIMEOUT - 1000,
    };

    startCycleTimeoutPoller(MAIN_JID, 999_999);
    await new Promise((r) => setTimeout(r, 0));

    expect(_getPendingCyclesForTest()[SUB_FOLDER]).toBeUndefined();

    const msgs = getMessagesSince(MAIN_JID, '', '');
    expect(msgs.some((m) => m.content.includes('timed out'))).toBe(true);
    expect(msgs.some((m) => m.content.includes(SUB_FOLDER))).toBe(true);
  });

  it('does not inject a notice for a cycle within the timeout window', async () => {
    _getPendingCyclesForTest()[SUB_FOLDER] = {
      taskId: 'task-fresh',
      delegatedAt: Date.now(),
    };

    startCycleTimeoutPoller(MAIN_JID, 999_999);
    await new Promise((r) => setTimeout(r, 0));

    expect(_getPendingCyclesForTest()[SUB_FOLDER]).toBeDefined();
    const msgs = getMessagesSince(MAIN_JID, '', '');
    expect(msgs.some((m) => m.content.includes('timed out'))).toBe(false);
  });

  it('does not inject when there are no pending cycles', async () => {
    startCycleTimeoutPoller(MAIN_JID, 999_999);
    await new Promise((r) => setTimeout(r, 0));

    const msgs = getMessagesSince(MAIN_JID, '', '');
    expect(msgs.some((m) => m.content.includes('timed out'))).toBe(false);
  });

  it('is idempotent — calling twice does not start a second loop', async () => {
    _getPendingCyclesForTest()[SUB_FOLDER] = {
      taskId: 'task-dup',
      delegatedAt: Date.now() - CYCLE_TIMEOUT - 1000,
    };

    startCycleTimeoutPoller(MAIN_JID, 999_999);
    startCycleTimeoutPoller(MAIN_JID, 999_999);
    await new Promise((r) => setTimeout(r, 0));

    const msgs = getMessagesSince(MAIN_JID, '', '');
    const timeoutMsgs = msgs.filter((m) => m.content.includes('timed out'));
    expect(timeoutMsgs).toHaveLength(1);
  });
});
