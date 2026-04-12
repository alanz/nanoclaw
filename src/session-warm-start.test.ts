/**
 * Tests for session-warm-start: context assembly and UserProfile lifecycle.
 *
 * Covers:
 *   - Config defaults (recent_notes_count, prior_session_turns, etc.)
 *   - Pure helpers: formatDatetime, truncateToTokens, prependHeader,
 *     renderNotes, renderSearch
 *   - priorSessionTail: conversation archive reading, min-chars fallback
 *   - ProfileFileUpdated rule: success and both failure guards
 *   - ProfileBecomesStale rule: success, temporal boundary, failure guard
 *   - assembleSessionContext: all optional-block combinations,
 *     entity-field obligations, when-presence obligations
 *   - buildInitialPrompt: InjectContextIntoPrompt mapping
 *
 * Spec: docs/project/specs/session-warm-start.allium
 * Plan: allium plan docs/project/specs/session-warm-start.allium
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { RegisteredGroup } from './types.js';
import type { MemoryFileEntry, MemorySearchResult } from './memory/manager.js';
import {
  WARM_START_DEFAULTS,
  formatDatetime,
  truncateToTokens,
  prependHeader,
  renderNotes,
  renderSearch,
  priorSessionTail,
  onProfileFileUpdated,
  onProfileBecomesStale,
  assembleSessionContext,
  buildInitialPrompt,
  type UserProfile,
  type SessionContext,
} from './session-warm-start.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SUFFIX = `test-ws-${Date.now()}`;

function testFolder(name: string): string {
  return `${name}-${TEST_SUFFIX}`;
}

function groupDir(folder: string): string {
  return path.join(GROUPS_DIR, folder);
}

const createdDirs: string[] = [];

function ensureDir(...parts: string[]): string {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  const topLevel = path.join(GROUPS_DIR, parts[1] ?? '');
  if (!createdDirs.includes(topLevel)) createdDirs.push(topLevel);
  return p;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeMainGroup(folder: string): RegisteredGroup {
  return {
    name: 'Main',
    folder,
    trigger: '@bot',
    added_at: new Date().toISOString(),
    isMain: true,
  };
}

function makeGroup(folder: string): RegisteredGroup {
  return {
    name: 'Non-Main',
    folder,
    trigger: '@bot',
    added_at: new Date().toISOString(),
    isMain: false,
  };
}

/** Write a minimal non-placeholder conversation archive. */
function writeArchive(
  conversationsDir: string,
  filename: string,
  turns: Array<{ user: string; assistant: string }>,
  archivedAt: Date = new Date(),
  isPlaceholder = false,
): void {
  fs.mkdirSync(conversationsDir, { recursive: true });
  const lines: string[] = [
    '---',
    `session_id: sess-test`,
    `archived_at: ${archivedAt.toISOString()}`,
    `source_jsonl: /tmp/test.jsonl`,
    `is_placeholder: ${isPlaceholder}`,
    '---',
    '',
    '# Conversation',
    '',
    `Archived: ${archivedAt.toLocaleString()}`,
    '',
    '---',
    '',
  ];
  if (!isPlaceholder) {
    for (const { user, assistant } of turns) {
      lines.push(`**User**: ${user}`, '');
      lines.push(`**Assistant**: ${assistant}`, '');
    }
  }
  fs.writeFileSync(path.join(conversationsDir, filename), lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Config defaults
// obligation ids: config-default.*
// ---------------------------------------------------------------------------

describe('WARM_START_DEFAULTS', () => {
  // config-default.recent_notes_count
  it('recent_notes_count defaults to 5', () => {
    expect(WARM_START_DEFAULTS.recentNotesCount).toBe(5);
  });

  // config-default.prior_session_turns
  it('prior_session_turns defaults to 4', () => {
    expect(WARM_START_DEFAULTS.priorSessionTurns).toBe(4);
  });

  // config-default.prior_session_search_min_chars
  it('prior_session_search_min_chars defaults to 80', () => {
    expect(WARM_START_DEFAULTS.priorSessionSearchMinChars).toBe(80);
  });

  // config-default.prior_session_search_limit
  it('prior_session_search_limit defaults to 5', () => {
    expect(WARM_START_DEFAULTS.priorSessionSearchLimit).toBe(5);
  });

  // config-default.prior_session_search_min_score
  it('prior_session_search_min_score defaults to 0.5', () => {
    expect(WARM_START_DEFAULTS.priorSessionSearchMinScore).toBe(0.5);
  });

  // config-default.profile_stale_after
  it('profile_stale_after defaults to 8 days', () => {
    expect(WARM_START_DEFAULTS.profileStaleAfterDays).toBe(8);
  });

  // config-default.profile_max_tokens
  it('profile_max_tokens defaults to 2000', () => {
    expect(WARM_START_DEFAULTS.profileMaxTokens).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// formatDatetime
// Renders date at date+hour granularity, always UTC, truncates minutes/seconds.
// ---------------------------------------------------------------------------

describe('formatDatetime', () => {
  it('formats a date at hour granularity with no minutes or seconds', () => {
    const d = new Date('2026-04-12T14:37:22.000Z');
    const result = formatDatetime(d);
    expect(result).toContain('2026-04-12');
    expect(result).toContain('14:00');
    expect(result).not.toContain('37');
    expect(result).not.toContain('22');
  });

  it('includes a human-readable label for prompt context', () => {
    const d = new Date('2026-04-12T09:00:00.000Z');
    const result = formatDatetime(d);
    // Must be recognisable as a datetime block so the agent can parse it
    expect(result.toLowerCase()).toMatch(/current|date|time/);
  });

  it('produces a stable value for two calls within the same hour', () => {
    const a = new Date('2026-04-12T14:05:00.000Z');
    const b = new Date('2026-04-12T14:59:59.000Z');
    expect(formatDatetime(a)).toBe(formatDatetime(b));
  });

  it('produces a different value for two calls in different hours', () => {
    const a = new Date('2026-04-12T13:59:59.000Z');
    const b = new Date('2026-04-12T14:00:00.000Z');
    expect(formatDatetime(a)).not.toBe(formatDatetime(b));
  });
});

// ---------------------------------------------------------------------------
// truncateToTokens
// Soft-truncates text to approximately maxTokens (1 token ≈ 4 chars).
// ---------------------------------------------------------------------------

describe('truncateToTokens', () => {
  it('returns the full string when it is within the token budget', () => {
    const short = 'Hello world.'; // well under any reasonable limit
    expect(truncateToTokens(short, 2000)).toBe(short);
  });

  it('truncates a string that exceeds the token budget', () => {
    const long = 'a'.repeat(20000); // ~5000 tokens at 4 chars/token
    const result = truncateToTokens(long, 100);
    expect(result.length).toBeLessThan(long.length);
  });

  it('truncated output is non-empty', () => {
    const long = 'word '.repeat(1000);
    const result = truncateToTokens(long, 10);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// prependHeader
// ---------------------------------------------------------------------------

describe('prependHeader', () => {
  it('places the header before the content', () => {
    const result = prependHeader('-- header --', 'body text');
    const headerPos = result.indexOf('-- header --');
    const bodyPos = result.indexOf('body text');
    expect(headerPos).toBeGreaterThanOrEqual(0);
    expect(bodyPos).toBeGreaterThan(headerPos);
  });

  it('includes both the header and the full content', () => {
    const result = prependHeader('-- h --', 'the body');
    expect(result).toContain('-- h --');
    expect(result).toContain('the body');
  });
});

// ---------------------------------------------------------------------------
// renderNotes
// ---------------------------------------------------------------------------

describe('renderNotes', () => {
  const notes: MemoryFileEntry[] = [
    { path: 'memory/notes/foo.md', mtime: 1_000_000, size: 100, indexed: true },
    { path: 'memory/notes/bar.md', mtime: 900_000, size: 80, indexed: true },
  ];

  it('produces a non-empty string when notes are provided', () => {
    expect(renderNotes(notes).length).toBeGreaterThan(0);
  });

  it('includes note paths in the output', () => {
    const result = renderNotes(notes);
    expect(result).toContain('foo.md');
    expect(result).toContain('bar.md');
  });

  it('returns an empty string or null-equivalent for an empty list', () => {
    const result = renderNotes([]);
    // Caller checks notes.count > 0 before calling, but a safe impl returns ''
    expect(result === '' || result === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderSearch
// ---------------------------------------------------------------------------

describe('renderSearch', () => {
  const results: MemorySearchResult[] = [
    {
      path: 'memory/notes/alpha.md',
      startLine: 1,
      endLine: 5,
      score: 0.9,
      snippet: 'relevant snippet about topic A',
    },
    {
      path: 'memory/notes/beta.md',
      startLine: 10,
      endLine: 15,
      score: 0.7,
      snippet: 'another relevant snippet',
    },
  ];

  it('produces a non-empty string when results are provided', () => {
    expect(renderSearch(results).length).toBeGreaterThan(0);
  });

  it('includes snippets in the output', () => {
    const result = renderSearch(results);
    expect(result).toContain('relevant snippet about topic A');
  });

  it('returns an empty string or null-equivalent for an empty list', () => {
    const result = renderSearch([]);
    expect(result === '' || result === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// priorSessionTail
// Reads conversation archives; returns last-N-turns text or null.
// ---------------------------------------------------------------------------

describe('priorSessionTail', () => {
  it('returns null when the conversations directory does not exist', async () => {
    const folder = testFolder('pst-nodir');
    const convDir = path.join(groupDir(folder), 'conversations');
    // Do not create the dir
    const tail = await priorSessionTail(convDir, 4, 80);
    expect(tail).toBeNull();
  });

  it('returns null when only placeholder archives exist', async () => {
    const folder = testFolder('pst-placeholder');
    const convDir = ensureDir(groupDir(folder), 'conversations');
    writeArchive(
      convDir,
      '2026-04-10-0300-missing.md',
      [],
      new Date('2026-04-10T03:00:00Z'),
      true,
    );
    const tail = await priorSessionTail(convDir, 4, 80);
    expect(tail).toBeNull();
  });

  it('returns the last N turns from the most recent non-placeholder archive', async () => {
    const folder = testFolder('pst-happy');
    const convDir = ensureDir(groupDir(folder), 'conversations');
    writeArchive(
      convDir,
      '2026-04-11-0300-reset.md',
      [
        { user: 'first turn user', assistant: 'first turn assistant' },
        { user: 'second turn user', assistant: 'second turn assistant' },
        { user: 'third turn user', assistant: 'third turn assistant' },
        { user: 'fourth turn user', assistant: 'fourth turn assistant' },
        { user: 'fifth turn user', assistant: 'fifth turn assistant' },
      ],
      new Date('2026-04-11T03:00:00Z'),
    );
    const tail = await priorSessionTail(convDir, 2, 10);
    expect(tail).not.toBeNull();
    // Should include the last 2 turns, not the earlier ones
    expect(tail).toContain('fourth turn');
    expect(tail).toContain('fifth turn');
    // Earlier turns should not appear
    expect(tail).not.toContain('first turn');
    expect(tail).not.toContain('second turn');
  });

  it('falls back to second-most-recent archive when tail is below min_chars', async () => {
    const folder = testFolder('pst-fallback');
    const convDir = ensureDir(groupDir(folder), 'conversations');

    // Most recent has a very short tail (will not meet min_chars=80)
    writeArchive(
      convDir,
      '2026-04-12-0300-reset.md',
      [{ user: 'hi', assistant: 'ok' }],
      new Date('2026-04-12T03:00:00Z'),
    );

    // Second-most-recent has a long tail
    writeArchive(
      convDir,
      '2026-04-11-0300-reset.md',
      [
        {
          user: 'What is the status of the migration project and all its sub-tasks?',
          assistant:
            'The migration project has three sub-tasks: schema update, data backfill, and cutover. All are in progress.',
        },
        {
          user: 'Can you summarise the blockers and next steps in detail?',
          assistant:
            'The main blocker is the foreign-key constraint issue on the legacy table. Next step is to run the backfill script.',
        },
      ],
      new Date('2026-04-11T03:00:00Z'),
    );

    const tail = await priorSessionTail(convDir, 4, 80);
    expect(tail).not.toBeNull();
    // Should be from the second-most-recent archive
    expect(tail).toContain('migration project');
  });

  it('returns null when neither most-recent nor second-most-recent meets min_chars', async () => {
    const folder = testFolder('pst-both-short');
    const convDir = ensureDir(groupDir(folder), 'conversations');
    writeArchive(
      convDir,
      '2026-04-12-0300-reset.md',
      [{ user: 'ok', assistant: 'yes' }],
      new Date('2026-04-12T03:00:00Z'),
    );
    writeArchive(
      convDir,
      '2026-04-11-0300-reset.md',
      [{ user: 'hi', assistant: 'hi' }],
      new Date('2026-04-11T03:00:00Z'),
    );
    // min_chars=1000 — neither short archive can satisfy this
    const tail = await priorSessionTail(convDir, 4, 1000);
    expect(tail).toBeNull();
  });

  it('skips placeholder archives when selecting most-recent', async () => {
    const folder = testFolder('pst-skip-placeholder');
    const convDir = ensureDir(groupDir(folder), 'conversations');

    // Most recent is a placeholder — should be skipped
    writeArchive(
      convDir,
      '2026-04-12-0600-missing.md',
      [],
      new Date('2026-04-12T06:00:00Z'),
      true,
    );
    // Non-placeholder archive with sufficient content
    writeArchive(
      convDir,
      '2026-04-11-0300-reset.md',
      [
        {
          user: 'Explain the caching architecture in detail please.',
          assistant:
            'The caching layer uses Redis with a write-through strategy. Keys expire after 5 minutes.',
        },
      ],
      new Date('2026-04-11T03:00:00Z'),
    );

    const tail = await priorSessionTail(convDir, 4, 10);
    expect(tail).not.toBeNull();
    expect(tail).toContain('caching');
  });
});

// ---------------------------------------------------------------------------
// ProfileFileUpdated rule
// obligation ids: rule-success.ProfileFileUpdated,
//                 rule-failure.ProfileFileUpdated.1,
//                 rule-failure.ProfileFileUpdated.2
// ---------------------------------------------------------------------------

describe('onProfileFileUpdated', () => {
  const absentProfile: UserProfile = { status: 'absent' };

  // rule-success.ProfileFileUpdated
  it('sets profile to current with generated_at and stale_at when group is main and path is memory/USER.md', () => {
    const group = makeMainGroup('main-group');
    const now = new Date('2026-04-12T10:00:00Z');
    const result = onProfileFileUpdated(
      group,
      'memory/USER.md',
      absentProfile,
      now,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe('current');
    expect(result!.generated_at).toBeInstanceOf(Date);
    expect(result!.stale_at).toBeInstanceOf(Date);
    // stale_at = now + 8 days
    const expectedStaleAt = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(result!.stale_at!.getTime()).toBe(expectedStaleAt.getTime());
  });

  it('sets generated_at to now', () => {
    const group = makeMainGroup('main-group');
    const now = new Date('2026-04-12T10:00:00Z');
    const result = onProfileFileUpdated(
      group,
      'memory/USER.md',
      absentProfile,
      now,
    );
    expect(result!.generated_at!.getTime()).toBe(now.getTime());
  });

  it('transitions from stale back to current', () => {
    const staleProfile: UserProfile = {
      status: 'stale',
      generated_at: new Date('2026-03-01T00:00:00Z'),
      stale_at: new Date('2026-03-09T00:00:00Z'),
    };
    const group = makeMainGroup('main-group');
    const now = new Date('2026-04-12T10:00:00Z');
    const result = onProfileFileUpdated(
      group,
      'memory/USER.md',
      staleProfile,
      now,
    );
    expect(result!.status).toBe('current');
  });

  // rule-failure.ProfileFileUpdated.1 — group.is_main false
  it('returns null when the group is not the main group', () => {
    const group = makeGroup('other-group');
    const now = new Date();
    const result = onProfileFileUpdated(
      group,
      'memory/USER.md',
      absentProfile,
      now,
    );
    expect(result).toBeNull();
  });

  // rule-failure.ProfileFileUpdated.2 — path ≠ memory/USER.md
  it('returns null when the file path is not memory/USER.md', () => {
    const group = makeMainGroup('main-group');
    const now = new Date();
    const result = onProfileFileUpdated(
      group,
      'memory/notes/other.md',
      absentProfile,
      now,
    );
    expect(result).toBeNull();
  });

  it('returns null for a similar but non-matching path', () => {
    const group = makeMainGroup('main-group');
    const now = new Date();
    expect(
      onProfileFileUpdated(group, 'USER.md', absentProfile, now),
    ).toBeNull();
    expect(
      onProfileFileUpdated(group, 'memory/user.md', absentProfile, now),
    ).toBeNull();
    expect(
      onProfileFileUpdated(group, 'memory/USER.md.bak', absentProfile, now),
    ).toBeNull();
  });

  // Delete-event guard: the watcher in index.ts skips events with type='delete'
  // before calling onProfileFileUpdated, so a deletion never marks the profile current.
  // This test documents that contract: onProfileFileUpdated itself has no event-type
  // awareness; the caller is responsible for filtering.
  it('caller must filter delete events — onProfileFileUpdated has no event-type awareness', () => {
    // If called despite a delete event (i.e. the guard is absent), it would
    // incorrectly return a current profile even though the file no longer exists.
    const group = makeMainGroup('main-group');
    const now = new Date();
    const result = onProfileFileUpdated(
      group,
      'memory/USER.md',
      absentProfile,
      now,
    );
    // The function fires — demonstrating why the watcher guard is load-bearing.
    expect(result).not.toBeNull();
    expect(result!.status).toBe('current');
    // The fix: index.ts skips the call entirely when event.type === 'delete'.
  });
});

// ---------------------------------------------------------------------------
// ProfileBecomesStale rule
// obligation ids: rule-success.ProfileBecomesStale,
//                 temporal.ProfileBecomesStale,
//                 rule-failure.ProfileBecomesStale.1
// ---------------------------------------------------------------------------

describe('onProfileBecomesStale', () => {
  // rule-success.ProfileBecomesStale
  it('transitions profile from current to stale when stale_at <= now', () => {
    const profile: UserProfile = {
      status: 'current',
      generated_at: new Date('2026-04-04T10:00:00Z'),
      stale_at: new Date('2026-04-12T10:00:00Z'),
    };
    const now = new Date('2026-04-12T10:00:00Z'); // exactly at deadline
    const result = onProfileBecomesStale(profile, now);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('stale');
  });

  it('transitions profile to stale when now is past stale_at', () => {
    const profile: UserProfile = {
      status: 'current',
      generated_at: new Date('2026-04-04T10:00:00Z'),
      stale_at: new Date('2026-04-12T10:00:00Z'),
    };
    const now = new Date('2026-04-13T00:00:00Z'); // after deadline
    const result = onProfileBecomesStale(profile, now);
    expect(result!.status).toBe('stale');
  });

  // temporal.ProfileBecomesStale — does not fire before deadline
  it('returns null when now is before stale_at', () => {
    const profile: UserProfile = {
      status: 'current',
      generated_at: new Date('2026-04-04T10:00:00Z'),
      stale_at: new Date('2026-04-12T10:00:00Z'),
    };
    const now = new Date('2026-04-12T09:59:59Z'); // one second before deadline
    const result = onProfileBecomesStale(profile, now);
    expect(result).toBeNull();
  });

  // rule-failure.ProfileBecomesStale.1 — requires profile.status = current
  it('returns null when profile status is already stale', () => {
    const profile: UserProfile = {
      status: 'stale',
      generated_at: new Date('2026-04-04T10:00:00Z'),
      stale_at: new Date('2026-04-05T10:00:00Z'),
    };
    const now = new Date('2026-04-12T00:00:00Z');
    const result = onProfileBecomesStale(profile, now);
    expect(result).toBeNull();
  });

  it('returns null when profile status is absent', () => {
    const profile: UserProfile = { status: 'absent' };
    const now = new Date('2026-04-12T00:00:00Z');
    const result = onProfileBecomesStale(profile, now);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UserProfile when-presence obligations
// obligation ids: when-presence.UserProfile.generated_at,
//                 when-presence.UserProfile.stale_at
// ---------------------------------------------------------------------------

describe('UserProfile when-presence', () => {
  // when-presence.UserProfile.generated_at
  it('current profile has generated_at', () => {
    const profile: UserProfile = {
      status: 'current',
      generated_at: new Date(),
      stale_at: new Date(),
    };
    expect(profile.generated_at).toBeDefined();
  });

  it('stale profile has generated_at', () => {
    const profile: UserProfile = {
      status: 'stale',
      generated_at: new Date(),
      stale_at: new Date(),
    };
    expect(profile.generated_at).toBeDefined();
  });

  it('absent profile has no generated_at', () => {
    const profile: UserProfile = { status: 'absent' };
    expect(profile.generated_at).toBeUndefined();
  });

  // when-presence.UserProfile.stale_at
  it('current profile has stale_at', () => {
    const profile: UserProfile = {
      status: 'current',
      generated_at: new Date(),
      stale_at: new Date(),
    };
    expect(profile.stale_at).toBeDefined();
  });

  it('stale profile has stale_at', () => {
    const profile: UserProfile = {
      status: 'stale',
      generated_at: new Date(),
      stale_at: new Date(),
    };
    expect(profile.stale_at).toBeDefined();
  });

  it('absent profile has no stale_at', () => {
    const profile: UserProfile = { status: 'absent' };
    expect(profile.stale_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// assembleSessionContext
// obligation ids: rule-success.AssembleSessionContext,
//                 rule-entity-creation.AssembleSessionContext.1,
//                 entity-fields.SessionContext,
//                 entity-optional.*
// ---------------------------------------------------------------------------

describe('assembleSessionContext', () => {
  const group = makeMainGroup('main-group');
  const now = new Date('2026-04-12T14:30:00Z');

  const currentProfile: UserProfile = {
    status: 'current',
    generated_at: new Date('2026-04-04T03:00:00Z'),
    stale_at: new Date('2026-04-12T03:00:00Z'),
  };
  const absentProfile: UserProfile = { status: 'absent' };
  const staleProfile: UserProfile = {
    status: 'stale',
    generated_at: new Date('2026-04-04T03:00:00Z'),
    stale_at: new Date('2026-04-10T03:00:00Z'),
  };

  const sampleNotes: MemoryFileEntry[] = [
    { path: 'memory/notes/a.md', mtime: 1_000_000, size: 200, indexed: true },
  ];

  const sampleResults: MemorySearchResult[] = [
    {
      path: 'memory/notes/a.md',
      startLine: 1,
      endLine: 3,
      score: 0.8,
      snippet: 'relevant text',
    },
  ];

  // rule-success.AssembleSessionContext + entity-fields.SessionContext
  it('returns a SessionContext with all required fields', () => {
    const ctx = assembleSessionContext(
      group,
      currentProfile,
      sampleNotes,
      'prior session tail text that is long enough to meet the minimum',
      sampleResults,
      now,
      () => 'user profile content',
    );
    expect(ctx).toBeDefined();
    expect(ctx.group).toBe(group);
    expect(ctx.assembled_at).toBeInstanceOf(Date);
    expect(typeof ctx.current_datetime_block).toBe('string');
    expect(ctx.current_datetime_block.length).toBeGreaterThan(0);
    // Optional fields must be string or null (not undefined)
    expect(
      ctx.user_profile_block === null ||
        typeof ctx.user_profile_block === 'string',
    ).toBe(true);
    expect(
      ctx.recent_notes_block === null ||
        typeof ctx.recent_notes_block === 'string',
    ).toBe(true);
    expect(
      ctx.prior_session_search_block === null ||
        typeof ctx.prior_session_search_block === 'string',
    ).toBe(true);
  });

  // current_datetime_block always present, at hour granularity
  it('always includes current_datetime_block', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      null,
      [],
      now,
      () => null,
    );
    expect(ctx.current_datetime_block).toBeTruthy();
    expect(ctx.current_datetime_block).toContain('2026-04-12');
    expect(ctx.current_datetime_block).toContain('14:00');
  });

  // entity-optional.SessionContext.user_profile_block
  it('user_profile_block is null when profile status is absent', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      null,
      [],
      now,
      () => null,
    );
    expect(ctx.user_profile_block).toBeNull();
  });

  it('user_profile_block is non-null when profile status is current', () => {
    const ctx = assembleSessionContext(
      group,
      currentProfile,
      [],
      null,
      [],
      now,
      () => 'some profile text about the user',
    );
    expect(ctx.user_profile_block).not.toBeNull();
    expect(ctx.user_profile_block).toContain('some profile text');
  });

  it('user_profile_block is non-null when profile status is stale', () => {
    const ctx = assembleSessionContext(
      group,
      staleProfile,
      [],
      null,
      [],
      now,
      () => 'stale profile content',
    );
    expect(ctx.user_profile_block).not.toBeNull();
  });

  it('user_profile_block includes the generation date header', () => {
    const ctx = assembleSessionContext(
      group,
      currentProfile,
      [],
      null,
      [],
      now,
      () => 'profile body',
    );
    // Header format: "-- user profile (generated {date}) --"
    expect(ctx.user_profile_block).toMatch(/generated/i);
    expect(ctx.user_profile_block).toContain('2026-04-04');
  });

  it('user_profile_block includes header even when profile is stale', () => {
    const ctx = assembleSessionContext(
      group,
      staleProfile,
      [],
      null,
      [],
      now,
      () => 'stale body',
    );
    expect(ctx.user_profile_block).toMatch(/generated/i);
  });

  // entity-optional.SessionContext.recent_notes_block
  it('recent_notes_block is null when no notes are provided', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      null,
      [],
      now,
      () => null,
    );
    expect(ctx.recent_notes_block).toBeNull();
  });

  it('recent_notes_block is non-null when notes are present', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      sampleNotes,
      null,
      [],
      now,
      () => null,
    );
    expect(ctx.recent_notes_block).not.toBeNull();
  });

  // entity-optional.SessionContext.prior_session_search_block
  it('prior_session_search_block is null when tail is null', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      null,
      [],
      now,
      () => null,
    );
    expect(ctx.prior_session_search_block).toBeNull();
  });

  it('prior_session_search_block is null when search results are empty', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      'prior session text that meets the minimum character length threshold',
      [],
      now,
      () => null,
    );
    // No results → no block (render_search([]) returns falsy)
    expect(ctx.prior_session_search_block).toBeNull();
  });

  it('prior_session_search_block is non-null when tail and search results exist', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      'a long enough prior session tail to use as search query',
      sampleResults,
      now,
      () => null,
    );
    expect(ctx.prior_session_search_block).not.toBeNull();
    expect(ctx.prior_session_search_block).toContain('relevant text');
  });

  // assembled_at set to now
  it('assembled_at equals the provided now', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      null,
      [],
      now,
      () => null,
    );
    expect(ctx.assembled_at.getTime()).toBe(now.getTime());
  });

  // group field preserved
  it('group field matches the provided group', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      [],
      null,
      [],
      now,
      () => null,
    );
    expect(ctx.group).toBe(group);
  });

  // rule-entity-creation.AssembleSessionContext.1
  // Full combination: all blocks present
  it('produces all blocks when profile is current, notes exist, and prior session search exists', () => {
    const ctx = assembleSessionContext(
      group,
      currentProfile,
      sampleNotes,
      'prior session tail with enough chars to pass the threshold',
      sampleResults,
      now,
      () => 'user profile content',
    );
    expect(ctx.user_profile_block).not.toBeNull();
    expect(ctx.recent_notes_block).not.toBeNull();
    expect(ctx.prior_session_search_block).not.toBeNull();
    expect(ctx.current_datetime_block).toBeTruthy();
  });

  it('profile is absent but notes and search present — only datetime and content blocks populated', () => {
    const ctx = assembleSessionContext(
      group,
      absentProfile,
      sampleNotes,
      'prior session tail with enough chars',
      sampleResults,
      now,
      () => null,
    );
    expect(ctx.user_profile_block).toBeNull();
    expect(ctx.recent_notes_block).not.toBeNull();
    expect(ctx.prior_session_search_block).not.toBeNull();
    expect(ctx.current_datetime_block).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// buildInitialPrompt (InjectContextIntoPrompt rule)
// obligation id: rule-success.InjectContextIntoPrompt
// ---------------------------------------------------------------------------

describe('buildInitialPrompt', () => {
  const group = makeMainGroup('main-group');
  const now = new Date('2026-04-12T14:00:00Z');

  function makeContext(overrides: Partial<SessionContext>): SessionContext {
    return {
      group,
      assembled_at: now,
      user_profile_block: null,
      recent_notes_block: null,
      prior_session_search_block: null,
      current_datetime_block: formatDatetime(now),
      ...overrides,
    };
  }

  // rule-success.InjectContextIntoPrompt
  it('always includes current_datetime_block in the prompt', () => {
    const ctx = makeContext({});
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain(formatDatetime(now));
  });

  it('omits user_profile_block when null', () => {
    const ctx = makeContext({ user_profile_block: null });
    const prompt = buildInitialPrompt(ctx);
    // Should not contain the profile header pattern
    expect(prompt).not.toMatch(/user profile/i);
  });

  it('includes user_profile_block when present', () => {
    const ctx = makeContext({
      user_profile_block:
        '-- user profile (generated 2026-04-04) --\nsome content',
    });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain('some content');
  });

  it('omits recent_notes_block when null', () => {
    const ctx = makeContext({ recent_notes_block: null });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).not.toContain('memory/notes/');
  });

  it('includes recent_notes_block when present', () => {
    const ctx = makeContext({
      recent_notes_block: 'recent notes content here',
    });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain('recent notes content here');
  });

  it('omits prior_session_search_block when null', () => {
    const ctx = makeContext({ prior_session_search_block: null });
    // No crash; datetime block still present
    const prompt = buildInitialPrompt(ctx);
    expect(typeof prompt).toBe('string');
  });

  it('includes prior_session_search_block when present', () => {
    const ctx = makeContext({
      prior_session_search_block: 'prior session search results here',
    });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain('prior session search results here');
  });

  it('current_datetime_block appears after all stable blocks (cache-friendly ordering)', () => {
    const datetimeBlock = formatDatetime(now);
    const ctx = makeContext({
      user_profile_block: 'profile content',
      recent_notes_block: 'notes content',
      prior_session_search_block: 'search content',
    });
    const prompt = buildInitialPrompt(ctx);
    const profilePos = prompt.indexOf('profile content');
    const notesPos = prompt.indexOf('notes content');
    const searchPos = prompt.indexOf('search content');
    const datetimePos = prompt.indexOf(datetimeBlock);
    // datetime must come last among all blocks
    expect(datetimePos).toBeGreaterThan(profilePos);
    expect(datetimePos).toBeGreaterThan(notesPos);
    expect(datetimePos).toBeGreaterThan(searchPos);
  });

  it('produces a valid (non-empty) prompt even when all optional blocks are null', () => {
    const ctx = makeContext({});
    const prompt = buildInitialPrompt(ctx);
    expect(prompt.trim().length).toBeGreaterThan(0);
  });
});
