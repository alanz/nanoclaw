import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs and config before importing the store
vi.mock('fs', () => {
  let storeData: string | null = null;
  return {
    default: {
      existsSync: vi.fn(() => storeData !== null),
      readFileSync: vi.fn(() => storeData ?? '{}'),
      writeFileSync: vi.fn((_path: string, data: string) => {
        storeData = data;
      }),
    },
  };
});

vi.mock('../config.js', () => ({
  DATA_DIR: '/tmp/webxdc-store-test/data',
}));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

// Import the module under test AFTER mocks
import {
  getActiveWebxdcMsgId,
  setActiveWebxdcSession,
  clearWebxdcSession,
  enqueueWebxdcUpdate,
  dequeueWebxdcUpdates,
  peekWebxdcUpdates,
  type WebxdcUpdateItem,
} from './webxdc-store.js';

function makeItem(overrides?: Partial<WebxdcUpdateItem>): WebxdcUpdateItem {
  return {
    content: 'Hello world',
    title: 'Andy',
    timestamp: 1000,
    ...overrides,
  };
}

describe('webxdc-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('session management', () => {
    it('returns undefined for unknown JID', () => {
      expect(getActiveWebxdcMsgId('dc:99')).toBeUndefined();
    });

    it('sets and retrieves an active session', () => {
      setActiveWebxdcSession('dc:10', 42);
      expect(getActiveWebxdcMsgId('dc:10')).toBe(42);
    });

    it('overwrites an existing session', () => {
      setActiveWebxdcSession('dc:10', 42);
      setActiveWebxdcSession('dc:10', 99);
      expect(getActiveWebxdcMsgId('dc:10')).toBe(99);
    });

    it('clearWebxdcSession removes the session', () => {
      setActiveWebxdcSession('dc:10', 42);
      clearWebxdcSession('dc:10');
      expect(getActiveWebxdcMsgId('dc:10')).toBeUndefined();
    });

    it('clearWebxdcSession is a no-op for unknown JID', () => {
      expect(() => clearWebxdcSession('dc:unknown')).not.toThrow();
    });
  });

  // Use a different msgId for each test to avoid cross-test state leakage
  // (the store has module-level state that persists across tests in the same run)
  let nextMsgId = 1000;
  function freshMsgId() {
    return nextMsgId++;
  }

  describe('update queue', () => {
    it('peek returns empty array when no items queued', () => {
      expect(peekWebxdcUpdates(freshMsgId())).toEqual([]);
    });

    it('enqueue then peek returns the item without removing it', () => {
      const id = freshMsgId();
      enqueueWebxdcUpdate(id, makeItem());
      expect(peekWebxdcUpdates(id)).toHaveLength(1);
      // Peek again — still there
      expect(peekWebxdcUpdates(id)).toHaveLength(1);
    });

    it('dequeue returns all items and clears the queue', () => {
      const id = freshMsgId();
      enqueueWebxdcUpdate(id, makeItem({ content: 'first' }));
      enqueueWebxdcUpdate(id, makeItem({ content: 'second' }));

      const items = dequeueWebxdcUpdates(id);
      expect(items).toHaveLength(2);
      expect(items[0].content).toBe('first');
      expect(items[1].content).toBe('second');
      // Queue is now empty
      expect(dequeueWebxdcUpdates(id)).toEqual([]);
    });

    it('dequeue returns empty array when queue is empty', () => {
      expect(dequeueWebxdcUpdates(freshMsgId())).toEqual([]);
    });

    it('queues are per msgId', () => {
      const id1 = freshMsgId();
      const id2 = freshMsgId();
      enqueueWebxdcUpdate(id1, makeItem({ content: 'for-1' }));
      enqueueWebxdcUpdate(id2, makeItem({ content: 'for-2' }));

      expect(peekWebxdcUpdates(id1)[0].content).toBe('for-1');
      expect(peekWebxdcUpdates(id2)[0].content).toBe('for-2');
    });

    it('setActiveWebxdcSession clears stale queue for the new msgId', () => {
      const id = freshMsgId();
      enqueueWebxdcUpdate(id, makeItem());
      setActiveWebxdcSession('dc:10', id); // re-register same msgId
      // Queue should be cleared
      expect(peekWebxdcUpdates(id)).toEqual([]);
    });

    it('clearWebxdcSession also clears the queue', () => {
      const id = freshMsgId();
      setActiveWebxdcSession('dc:11', id);
      enqueueWebxdcUpdate(id, makeItem());
      clearWebxdcSession('dc:11');
      expect(peekWebxdcUpdates(id)).toEqual([]);
    });

    it('preserves optional fields through enqueue/dequeue', () => {
      const id = freshMsgId();
      const item = makeItem({
        type: 'interactive',
        surfaceId: 'menu',
        components: [{ id: 'yes', type: 'button', label: 'Yes' }],
        description: 'Choose',
      });
      enqueueWebxdcUpdate(id, item);
      const [out] = dequeueWebxdcUpdates(id);
      expect(out.type).toBe('interactive');
      expect(out.surfaceId).toBe('menu');
      expect(out.description).toBe('Choose');
      expect(out.components).toHaveLength(1);
    });
  });
});
