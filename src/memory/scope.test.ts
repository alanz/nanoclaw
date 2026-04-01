/**
 * Tests for MEMORY_SEARCH_GROUPS scope filter in getOrCreateMemoryManager.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    MEMORY_SEARCH_ENABLED: true,
    MEMORY_SEARCH_GEMINI_API_KEY: 'test-key',
    MEMORY_SEARCH_GROUPS: new Set(['main']),
  };
});

import { getOrCreateMemoryManager } from './manager.js';

describe('getOrCreateMemoryManager group scope filter', () => {
  it('returns null for a group not in MEMORY_SEARCH_GROUPS', async () => {
    const mgr = await getOrCreateMemoryManager('deltachat_intake');
    expect(mgr).toBeNull();
  });

  it('returns null for an arbitrary unknown group', async () => {
    const mgr = await getOrCreateMemoryManager('some_other_group');
    expect(mgr).toBeNull();
  });
});
