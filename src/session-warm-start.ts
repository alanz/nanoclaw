/**
 * Session warm-start: assembles stable user context into the initial prompt
 * for every container spawn (message-triggered and task-triggered).
 *
 * Spec: docs/project/specs/session-warm-start.allium
 *
 * Phases:
 *   Phase 1 — UserProfile lifecycle (absent → current → stale → current)
 *   Phase 2 — recent A-MEM notes by mtime (main group only)
 *   Phase 3 — prior-session tail used as a hybrid-search query
 *
 * Host-side integration points:
 *   - Call `initWarmStart()` once at startup to load persisted state and
 *     start the USER.md file watcher for the main group.
 *   - Call `buildWarmStartPrompt(group, conversationsDir, memoryManager)` just
 *     before each `runContainerAgent` invocation; prepend the returned string
 *     (if non-empty) to the ContainerInput.prompt.
 */
import fs from 'fs';
import path from 'path';

import type { MemoryFileEntry, MemorySearchResult } from './memory/manager.js';
import { RegisteredGroup } from './types.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Config defaults
// Spec: config block in session-warm-start.allium
// ---------------------------------------------------------------------------

export const WARM_START_DEFAULTS = {
  /** Number of A-MEM notes injected by recency (Phase 2). */
  recentNotesCount: 5,
  /** Tail turns from prior session used as search query (Phase 3). */
  priorSessionTurns: 4,
  /** Minimum tail length in chars; fall back to second-most-recent if not met. */
  priorSessionSearchMinChars: 80,
  /** Max notes returned by prior-session search (Phase 3). */
  priorSessionSearchLimit: 5,
  /** Minimum search score threshold (Phase 3). */
  priorSessionSearchMinScore: 0.5,
  /** Days before profile transitions from current → stale. */
  profileStaleAfterDays: 8,
  /** Soft token budget passed to the profile-generation agent; hard limit at injection. */
  profileMaxTokens: 2000,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserProfileStatus = 'absent' | 'current' | 'stale';

/** Spec entity: UserProfile (singleton, persisted to DATA_DIR/user-profile.json). */
export interface UserProfile {
  status: UserProfileStatus;
  /** Present when status in {current, stale}. */
  generated_at?: Date;
  /** Present when status in {current, stale}. Deadline for ProfileBecomesStale. */
  stale_at?: Date;
}

/** Serialised form stored on disk (Dates as ISO strings). */
interface PersistedProfile {
  status: UserProfileStatus;
  generated_at?: string;
  stale_at?: string;
}

/** Spec entity: SessionContext (transient, created per spawn). */
export interface SessionContext {
  group: RegisteredGroup;
  assembled_at: Date;
  /** null when profile.status = absent. */
  user_profile_block: string | null;
  /** null when no A-MEM notes exist for the main group. */
  recent_notes_block: string | null;
  /** null when no prior session or tail too short. */
  prior_session_search_block: string | null;
  /** Always present; injected last to preserve provider cache hits. */
  current_datetime_block: string;
}

// ---------------------------------------------------------------------------
// Profile persistence
// ---------------------------------------------------------------------------

const PROFILE_PATH = path.join(DATA_DIR, 'user-profile.json');

function deserialiseProfile(p: PersistedProfile): UserProfile {
  return {
    status: p.status,
    generated_at: p.generated_at ? new Date(p.generated_at) : undefined,
    stale_at: p.stale_at ? new Date(p.stale_at) : undefined,
  };
}

export function loadUserProfile(): UserProfile {
  try {
    const raw = fs.readFileSync(PROFILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedProfile;
    return deserialiseProfile(parsed);
  } catch {
    return { status: 'absent' };
  }
}

export function saveUserProfile(profile: UserProfile): void {
  try {
    fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    const serialised: PersistedProfile = {
      status: profile.status,
      generated_at: profile.generated_at?.toISOString(),
      stale_at: profile.stale_at?.toISOString(),
    };
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(serialised, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to persist user profile');
  }
}

// ---------------------------------------------------------------------------
// Rule: ProfileFileUpdated
// Spec: when WorkspaceFileChanged(group, path, _)
//       requires: group.is_main && path = "memory/USER.md"
// ---------------------------------------------------------------------------

/**
 * Called when the file watcher observes a change in the main group workspace.
 * Returns the updated profile when the rule fires, or null when a `requires`
 * clause is not satisfied (non-main group or wrong path).
 *
 * Obligation ids: rule-success.ProfileFileUpdated,
 *                 rule-failure.ProfileFileUpdated.1,
 *                 rule-failure.ProfileFileUpdated.2
 */
export function onProfileFileUpdated(
  group: RegisteredGroup,
  filePath: string,
  profile: UserProfile,
  now: Date,
): UserProfile | null {
  // requires: group.is_main
  if (!group.isMain) return null;
  // requires: path = "memory/USER.md"
  if (filePath !== 'memory/USER.md') return null;

  const staleAt = new Date(
    now.getTime() +
      WARM_START_DEFAULTS.profileStaleAfterDays * 24 * 60 * 60 * 1000,
  );
  const updated: UserProfile = {
    ...profile,
    status: 'current',
    generated_at: now,
    stale_at: staleAt,
  };
  logger.info(
    { generated_at: now.toISOString() },
    'UserProfile updated to current',
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Rule: ProfileBecomesStale
// Spec: when _: UserProfile.stale_at <= now
//       requires: profile.status = current
// ---------------------------------------------------------------------------

/**
 * Should be called on each spawn (and optionally on a periodic timer) to check
 * whether the profile deadline has passed.
 * Returns the updated profile when the rule fires, or null when preconditions
 * are not met (status ≠ current or now < stale_at).
 *
 * Obligation ids: rule-success.ProfileBecomesStale,
 *                 temporal.ProfileBecomesStale,
 *                 rule-failure.ProfileBecomesStale.1
 */
export function onProfileBecomesStale(
  profile: UserProfile,
  now: Date,
): UserProfile | null {
  // requires: profile.status = current
  if (profile.status !== 'current') return null;
  // temporal trigger: stale_at <= now
  if (!profile.stale_at || profile.stale_at.getTime() > now.getTime())
    return null;

  const updated: UserProfile = { ...profile, status: 'stale' };
  logger.info(
    { stale_at: profile.stale_at.toISOString() },
    'UserProfile became stale',
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Renders a date at date+hour granularity (UTC), truncating minutes and seconds.
 * Produces a stable value within the same hour to limit provider cache misses.
 *
 * Example output: "Current date/time: 2026-04-12T14:00Z"
 */
export function formatDatetime(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `Current date/time: ${year}-${month}-${day}T${hour}:00Z`;
}

/**
 * Soft-truncates text to approximately maxTokens (1 token ≈ 4 chars).
 * Truncation is on a character boundary; does not split mid-word.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  // Walk back to a word boundary to avoid splitting mid-word.
  let cut = maxChars;
  while (cut > 0 && text[cut] !== ' ' && text[cut] !== '\n') cut--;
  return text.slice(0, cut > 0 ? cut : maxChars);
}

/**
 * Prepends a header line to content, separated by a newline.
 * Used to add the generation-date header to the USER.md content.
 *
 * Example: prependHeader("-- user profile (generated 2026-04-04) --", body)
 */
export function prependHeader(header: string, content: string): string {
  return `${header}\n${content}`;
}

/**
 * Formats a list of recent memory note paths as a prompt-ready block.
 * Returns '' when notes is empty (caller checks count > 0 before setting the block).
 */
export function renderNotes(notes: MemoryFileEntry[]): string {
  if (notes.length === 0) return '';
  const items = notes.map((n) => `- ${n.path}`).join('\n');
  return `-- recent memory notes (most recent first) --\n${items}`;
}

/**
 * Formats memory search results as a prompt-ready block.
 * Returns '' when results is empty.
 */
export function renderSearch(results: MemorySearchResult[]): string {
  if (results.length === 0) return '';
  const items = results
    .map(
      (r) =>
        `[path: ${r.path}, lines: ${r.startLine}-${r.endLine}, score: ${r.score.toFixed(2)}]\n${r.snippet}`,
    )
    .join('\n\n');
  return `-- related notes from prior session --\n${items}`;
}

// ---------------------------------------------------------------------------
// priorSessionTail
// Reads conversation archives; returns the last-N-turns text or null.
// ---------------------------------------------------------------------------

interface ArchiveEntry {
  filename: string;
  archivedAt: Date;
  isPlaceholder: boolean;
}

function parseArchiveFrontmatter(content: string): {
  archivedAt?: string;
  isPlaceholder?: boolean;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const archivedAt = yaml.match(/^archived_at:\s*(.+)$/m)?.[1]?.trim();
  const isPlaceholderStr = yaml.match(/^is_placeholder:\s*(.+)$/m)?.[1]?.trim();
  return {
    archivedAt,
    isPlaceholder: isPlaceholderStr === 'true',
  };
}

/**
 * Extracts the last `numTurns` user/assistant turn-pairs from a conversation
 * archive's body (below the frontmatter `---` separator).
 * Returns the turns joined as a single string.
 */
function extractTailFromArchive(content: string, numTurns: number): string {
  // Drop frontmatter: everything up to and including the second '---'
  const bodyStart = content.indexOf('\n---\n', content.indexOf('---\n') + 1);
  const body = bodyStart >= 0 ? content.slice(bodyStart + 5) : content;

  // Split on double-newline to get paragraph-like blocks
  const blocks = body
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => /^\*\*(User|Assistant)\*\*:/.test(b));

  // Each turn is a User + Assistant pair.
  // We want the last numTurns pairs = last numTurns * 2 blocks.
  const maxBlocks = numTurns * 2;
  const tail = blocks.slice(-maxBlocks);
  return tail.join('\n\n');
}

/**
 * Returns the last `numTurns` turns from the most recent non-placeholder
 * conversation archive in `conversationsDir`, or falls back to the
 * second-most-recent if the primary tail is below `minChars`.
 * Returns null if no qualifying archive is found.
 *
 * Obligation ids: (covered by priorSessionTail tests)
 */
export async function priorSessionTail(
  conversationsDir: string,
  numTurns: number,
  minChars: number,
): Promise<string | null> {
  if (!fs.existsSync(conversationsDir)) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(conversationsDir);
  } catch {
    return null;
  }

  // Parse frontmatter for each .md file
  const archives: ArchiveEntry[] = [];
  for (const filename of entries) {
    if (!filename.endsWith('.md')) continue;
    const fullPath = path.join(conversationsDir, filename);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const { archivedAt, isPlaceholder } = parseArchiveFrontmatter(content);
      if (archivedAt) {
        archives.push({
          filename,
          archivedAt: new Date(archivedAt),
          isPlaceholder: isPlaceholder ?? false,
        });
      }
    } catch {
      // Unreadable file — skip
    }
  }

  // Only non-placeholder archives carry real conversation content
  const real = archives
    .filter((a) => !a.isPlaceholder)
    .sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime());

  if (real.length === 0) return null;

  // Try the most-recent archive first, then fall back to the second-most-recent.
  for (const entry of real.slice(0, 2)) {
    const fullPath = path.join(conversationsDir, entry.filename);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const tail = extractTailFromArchive(content, numTurns);
      if (tail.length >= minChars) return tail;
    } catch {
      // Unreadable — skip
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule: AssembleSessionContext
// Spec: when ContainerAboutToSpawn(group)
// ---------------------------------------------------------------------------

/**
 * Assembles the warm-start SessionContext from pre-fetched data.
 * Purely computational — all async I/O (memory search, priorSessionTail, profile
 * file read) is done by the caller and passed in as arguments.
 *
 * `readProfileFile` returns the content of memory/USER.md for the main group,
 * or null if the file does not exist.
 *
 * Obligation ids: rule-success.AssembleSessionContext,
 *                 rule-entity-creation.AssembleSessionContext.1,
 *                 entity-optional.*
 */
export function assembleSessionContext(
  group: RegisteredGroup,
  profile: UserProfile,
  notes: MemoryFileEntry[],
  tail: string | null,
  searchResults: MemorySearchResult[],
  now: Date,
  readProfileFile: () => string | null,
): SessionContext {
  // user_profile_block: non-null only when profile.status in {current, stale}
  let userProfileBlock: string | null = null;
  if (profile.status === 'current' || profile.status === 'stale') {
    const content = readProfileFile();
    if (content !== null) {
      const header = `-- user profile (generated ${profile.generated_at?.toISOString().slice(0, 10) ?? 'unknown'}) --`;
      const truncated = truncateToTokens(
        content,
        WARM_START_DEFAULTS.profileMaxTokens,
      );
      userProfileBlock = prependHeader(header, truncated);
    }
  }

  // recent_notes_block: non-null when notes are present
  const recentNotesRaw = renderNotes(notes);
  const recentNotesBlock = recentNotesRaw || null;

  // prior_session_search_block: non-null when tail is non-null AND search returned results
  let priorSessionSearchBlock: string | null = null;
  if (tail !== null) {
    const searchRaw = renderSearch(searchResults);
    priorSessionSearchBlock = searchRaw || null;
  }

  // current_datetime_block: always present, injected last
  const currentDatetimeBlock = formatDatetime(now);

  return {
    group,
    assembled_at: now,
    user_profile_block: userProfileBlock,
    recent_notes_block: recentNotesBlock,
    prior_session_search_block: priorSessionSearchBlock,
    current_datetime_block: currentDatetimeBlock,
  };
}

// ---------------------------------------------------------------------------
// Rule: InjectContextIntoPrompt
// Spec: when context: SessionContext.created → InitialPromptAssembled
// ---------------------------------------------------------------------------

/**
 * Renders a SessionContext as a prefix string to prepend to the container
 * prompt. Blocks are ordered so that stable blocks come first (eligible for
 * provider cache hits); the volatile `current_datetime_block` is always last.
 * Null blocks are silently omitted.
 *
 * Block order:
 *   1. user_profile_block          (omitted when profile.status = absent)
 *   2. recent_notes_block          (omitted when empty)
 *   3. prior_session_search_block  (omitted when null)
 *   4. current_datetime_block      (always present, always last)
 *
 * Obligation id: rule-success.InjectContextIntoPrompt
 */
export function buildInitialPrompt(context: SessionContext): string {
  const blocks: string[] = [];

  if (context.user_profile_block !== null) {
    blocks.push(context.user_profile_block);
  }
  if (context.recent_notes_block !== null) {
    blocks.push(context.recent_notes_block);
  }
  if (context.prior_session_search_block !== null) {
    blocks.push(context.prior_session_search_block);
  }
  blocks.push(context.current_datetime_block);

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Integration helper
// Called by index.ts and task-scheduler.ts before each runContainerAgent.
// ---------------------------------------------------------------------------

/** Minimal slice of MemoryIndexManager needed by buildWarmStartPrompt. */
export interface WarmStartMemoryManager {
  listFiles(opts: {
    pathPrefix?: string;
    limit?: number;
    orderBy?: 'mtime' | 'path' | 'size';
  }): { files: MemoryFileEntry[]; total: number };
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      pathPrefix?: string;
    },
  ): Promise<MemorySearchResult[]>;
}

/**
 * Full async assembly: fetches notes + runs prior-session search, then returns
 * a warm-start prefix string (may be empty if profile is absent and no notes
 * or prior session exist).
 *
 * `mainGroupDir` is the absolute host-side path to the main group workspace
 * (used to resolve memory/USER.md and conversations/).
 */
export async function buildWarmStartPrompt(
  group: RegisteredGroup,
  mainGroupDir: string,
  profile: UserProfile,
  memoryManager: WarmStartMemoryManager | null,
): Promise<string> {
  const now = new Date();

  // Fetch recent notes from main group (Phase 2)
  const notes: MemoryFileEntry[] =
    memoryManager?.listFiles({
      pathPrefix: 'memory/notes/',
      limit: WARM_START_DEFAULTS.recentNotesCount,
      orderBy: 'mtime',
    }).files ?? [];

  // Fetch prior-session tail (Phase 3)
  const conversationsDir = path.join(mainGroupDir, 'conversations');
  const tail = await priorSessionTail(
    conversationsDir,
    WARM_START_DEFAULTS.priorSessionTurns,
    WARM_START_DEFAULTS.priorSessionSearchMinChars,
  );

  // Run hybrid search if we have a tail (Phase 3)
  let searchResults: MemorySearchResult[] = [];
  if (tail !== null && memoryManager) {
    try {
      searchResults = await memoryManager.search(tail, {
        maxResults: WARM_START_DEFAULTS.priorSessionSearchLimit,
        minScore: WARM_START_DEFAULTS.priorSessionSearchMinScore,
        pathPrefix: 'memory/notes/',
      });
    } catch (err) {
      logger.warn({ err }, 'Warm-start prior-session search failed');
    }
  }

  // Read USER.md from main group workspace
  const readProfileFile = (): string | null => {
    try {
      return fs.readFileSync(
        path.join(mainGroupDir, 'memory', 'USER.md'),
        'utf-8',
      );
    } catch {
      return null;
    }
  };

  const ctx = assembleSessionContext(
    group,
    profile,
    notes,
    tail,
    searchResults,
    now,
    readProfileFile,
  );
  return buildInitialPrompt(ctx);
}

// ---------------------------------------------------------------------------
// Profile generation
// Spec: ProfileFileUpdated @guidance — the agent task that writes memory/USER.md
// ---------------------------------------------------------------------------

/**
 * Prompt for the profile-generation agent.
 * Instructs it to synthesise memory/USER.md from all available memory sources.
 * Exported so callers (tests, alternative triggers) can inspect or override it.
 */
export const PROFILE_GENERATION_PROMPT = `Your task is to synthesise a user profile and write it to memory/USER.md.

This file is injected into the context of every future session so the agent knows who the user is and what they are currently focused on. Weight recent activity heavily — the goal is to capture current focus and in-progress work, not a historical average.

## Sources to read

Read as many of these as exist:
- memory/notes/          — all A-MEM notes (use Glob then Read)
- memory/sessions/       — session summary files (use Glob then Read)
- memory/research-topics.md — if it exists
- memory/USER.md         — the prior profile, if it exists (carry forward anything still relevant; drop anything that no longer reflects the user's current focus)
- /workspace/extra/org/  — org GTD files if mounted (use Glob then Read)

## Output

Write a complete rewrite of memory/USER.md. Do not patch or append to the existing file — overwrite it entirely. Anything still relevant from the prior profile should be carried forward; anything stale or no longer relevant should be dropped.

Keep the total length under ${WARM_START_DEFAULTS.profileMaxTokens} tokens. Be concise and specific. Prioritise what is currently active over what is historically interesting.

Write the file now using the Write tool. Do not explain what you are doing.`;

/** Slim interface for the container runner dependency — keeps the function testable. */
export interface ProfileGenerationRunner {
  runContainerAgent: (
    group: RegisteredGroup,
    input: {
      prompt: string;
      groupFolder: string;
      chatJid: string;
      isMain: boolean;
      isScheduledTask: boolean;
      assistantName: string;
    },
    onProcess: (proc: unknown, containerName: string) => void,
    onOutput?: (output: { status: string }) => Promise<void>,
  ) => Promise<{ status: string; error?: string }>;
}

/**
 * Spawns an isolated agent on the main group to synthesise memory/USER.md.
 * Writes nothing to the chat — the result is communicated via the file watcher
 * (onProfileFileUpdated fires when the agent writes the file).
 *
 * Decoupled from the trigger: call from a cron task, session-end hook, or
 * anywhere else without changing this function.
 *
 * @param prompt - The prompt to use. Defaults to PROFILE_GENERATION_PROMPT.
 *   Callers can load a custom prompt from disk (e.g. prompts/user-profile-prompt.md)
 *   and pass it here.
 * @param onOutput - Optional streaming callback, forwarded to the container
 *   runner. The scheduler uses this to close the container promptly after the
 *   agent finishes rather than waiting for the process to exit on its own.
 */
export async function generateUserProfile(
  group: RegisteredGroup,
  chatJid: string,
  assistantName: string,
  runner: ProfileGenerationRunner,
  onOutput?: (output: { status: string }) => Promise<void>,
  prompt: string = PROFILE_GENERATION_PROMPT,
): Promise<void> {
  logger.info({ group: group.folder }, 'Starting user profile generation');
  try {
    const output = await runner.runContainerAgent(
      group,
      {
        prompt,
        groupFolder: group.folder,
        chatJid,
        isMain: true,
        isScheduledTask: true,
        assistantName,
      },
      () => {}, // background task — no process registration needed
      onOutput,
    );
    if (output.status === 'error') {
      logger.error(
        { group: group.folder, error: output.error },
        'User profile generation failed',
      );
    } else {
      logger.info({ group: group.folder }, 'User profile generation complete');
    }
  } catch (err) {
    logger.error({ err, group: group.folder }, 'User profile generation threw');
  }
}
