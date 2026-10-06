# Session reset and session summaries — design

Status: **implemented** (2026-10-06) in `src/modules/session-reset/`. Spec:
[`specs/session-reset.allium`](../specs/session-reset.allium) (approved by the owner 2026-10-06).

Ports v1's daily session reset and its session summaries (see
[v1-migration-gaps.md](v1-migration-gaps.md) §1 "Session reset + summary" and
§3). Decisions taken with the owner on 2026-10-06:

| Question              | Decision                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Trigger               | Daily at 04:00 (group timezone), only if the chat has been idle ≥ 60 min; otherwise skip that day (as v1)              |
| Scope                 | Opt-in list of group folders; start with `dm-with-alanz` chat sessions only. Never task or specialist sessions         |
| Read-back             | The summariser keeps `memory/sessions/index.md` (last 7, one line each), linked from the root Map in `memory/index.md` |
| `/clear` and rotation | Also archived and summarised: the host notices the conversation ended and sweeps it up                                 |

## What v1 did (for reference)

- A `session_reset` scheduled task (`0 4 * * *`, `min_idle_minutes = 60`) or a
  manual `/reset`. Busy → "Skipped: group active Nm ago".
- Archive the conversation since the previous archive to
  `conversations/YYYY-MM-DD-HHmm-reset.md`; spawn a throwaway agent that reads
  it and writes `memory/sessions/<datetime>.md`; drop the SDK session id.
- Up to 3 retries, then `<dt>-failed.md` and a message to main;
  `/retry-summary`, `list_failed_summaries`.
- The user saw only reactions (⏳ → 💭).
- Summaries were read back only by memory search and the weekly profile task —
  warm-start never read `memory/sessions/`.

## Constraints in v2

- The conversation id lives in the container's `outbound.db`
  (`session_state`, key `continuation:<provider>`). The host must not write
  it (single writer per DB).
- `NANOCLAW_FRESH_CONVERSATION=1` at container start makes the runner drop
  the stored id itself (`container/agent-runner/src/index.ts`). A module can
  set it through `registerSessionContributor` — the specialists module does
  exactly this.
- An idle chat container is reaped after 30 min, so at 04:00 there is
  normally no container: a reset needs no wake and no LLM call in the chat.
- Transcripts are on the host:
  `data/v2-sessions/<agent-group>/.claude-shared/projects/-workspace-agent/<id>.jsonl`
  (rotated ones as `<id>.jsonl.rotated-<ms>`), shared by all sessions of the
  group. They do not say which session wrote them, so the host must remember
  which conversation ids belong to which chat session.
- Upstream's `cross-session-context` does nothing for a single-session DM
  (it seeds from _sibling_ sessions), and nothing for a new conversation in
  the same session.

## Design: a host-only fork module, `src/modules/session-reset/`

No container code, no upstream file patched. Self-registers through
`src/modules/index.ts` like the other fork modules.

### 1. Observe conversations

On a 60 s timer (`onHostStart`, unref'd, like specialists) and from
`registerSessionExitHook`, for each active chat session of a reset group:
read `continuation:claude` from its `outbound.db` (read-only).

- New id → insert a `Conversation` row (active). Any other active row of the
  session is ended: `rotated` if its transcript is now `*.rotated-*`, else
  `cleared`.
- Key absent → the active row ended (`cleared`).

Table `session_conversations` (module migration): session_id,
conversation_id, status, end_reason, first_seen_at, ended_at, archive_path,
summary_status, summary_attempts, summary_task_id, summary_path.

Limitation (recorded): an id created and replaced between two observations
(two `/clear`s within a minute) is never seen.

### 2. Daily reset

At the first tick at/after 04:00 in the group's timezone
(`resolveGroupTimezone`), once per session per day:

- skip unless the session is active, has a messaging group, its container is
  not running, and the newest of last inbound (`sessions.last_active`), last
  outbound (`messages_out.timestamp`) and the heartbeat is ≥ 60 min old;
- skip if the session has no active conversation (nothing happened since the
  last reset);
- otherwise end the conversation (`reset`) and insert a pending
  `session_resets` row.

The module's session contributor returns
`env: { NANOCLAW_FRESH_CONVERSATION: '1' }` while a pending reset exists for
the session, and marks it applied. The next message therefore starts a fresh
conversation, which loads `memory/index.md` + `system/definition.md` as at any
startup. The user sees nothing.

Race: write the pending row first, then re-check that no container is
running; if one is, delete the row and skip the day.

### 3. Archive

When a conversation ends (any reason), the host converts its transcript to
`groups/<folder>/conversations/YYYY-MM-DD-HHmm-<reason>.md`: frontmatter
`session`, `conversation_id`, `archived_at`, `end_reason`; then
`**User**:` / `**<assistant name>**:` lines, each message capped at 2000
chars, user and assistant text only — the same shape as the runner's
PreCompact archive (`providers/claude-history.ts`), re-implemented on the host
(host and container share no modules). Missing/empty transcript →
`-missing` / `-empty` placeholder, summary marked failed.

With daily resets each archive is one conversation, so v1's "messages since
the last archive" bookkeeping is not needed. A rotated conversation was
already archived by the runner's rotation; it is archived again here, once,
for a predictable name.

### 4. Summarise

Each tick, for each archived conversation without a summary and with no
summary task running: create a one-shot task in the agent group
(`createScheduledTask`, `processAfter: now`), attempts + 1. The task runs in
its own session with a fresh conversation; its final text stays in the task
run log, never the chat. Prompt (v1's, adapted):

> Read the conversation archive at `/workspace/agent/conversations/<file>`.
> Write a summary to `/workspace/agent/memory/sessions/<date>-<HHmm>.md`:
> frontmatter `type: session-summary`, `session`, `conversation_id`,
> `archive`, `created`; then **Summary**, **Decisions**, **Facts learned**,
> **Open questions**, **Tasks completed / started**. Then add a one-line entry
> at the top of `memory/sessions/index.md` (create it if missing, keep the
> newest 7) linking the summary. Do not message the user. Stop when done.

Completion: the task finished and the summary file exists → `done`. After 3
attempts without a file → write `memory/sessions/<date>-<HHmm>-failed.md`
naming the archive, mark `failed`, and tell the owner once (normal delivery).
Retries need no tools: the next tick reschedules.

Summaries are under `memory/`, so memory search indexes them (source
`memory`).

### 5. Read-back

One-time setup in Andy's group: add to the root Map in `memory/index.md`

    - [Recent sessions](sessions/index.md) - one-line summaries of the last 7 conversations

`index.md` is loaded at every context start, so a fresh conversation sees the
pointer; the agent opens `sessions/index.md` or a summary when it is
relevant. No runner or context patch.

## Configuration

`.env`: `SESSION_RESET_GROUPS=dm-with-alanz` (empty → off),
`SESSION_RESET_TIME=04:00`, `SESSION_RESET_MIN_IDLE_MINUTES=60`.

## Not in scope

- PreCompact archives that repeat the whole transcript (overlapping copies in
  `conversations/`). Daily resets keep them short; left as is.
- The user profile (deferred until summaries flow again).
- A visible "reset" notice in the chat.

## Open

- Backfill (owner: later, optional, once this runs): summarise conversations from before the module existed? The
  Sep 24 – Oct 4 chat (`df4578eb…`, archive `2026-10-04-conversation-1509.md`)
  and the 8 rotated transcripts since May are still on disk.
- Agent-to-agent sessions of a reset group: excluded in this draft.
