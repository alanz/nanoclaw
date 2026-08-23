# V1 → V2 Migration Gaps

Features present in v1 (`~/nanoclaw`), or carried into v1 from OpenClaw
(`~/.openclaw`), that are not yet in v2. The migration is incomplete: an item
listed here as open is meant to be restored, not dropped, unless it is marked
obsolete.

Last audited 2026-10-04, when the main agent's standing instructions were
cleaned of every v1-era section describing a feature v2 lacks. Each removed
section is accounted for below.

Snapshots taken at that audit (outside the repo, so they survive v1 being
removed):

- `~/nanoclaw-v2-backups/v1-tasks-and-feeds-20261004.json` — every active and
  paused v1 scheduled task (prompt, gate script, schedule, task type) and the
  v1 `rss_feeds` table.
- `~/nanoclaw-v2-backups/v1-prompts-20261004/` — v1's main-group `CLAUDE.md`
  and the `reset-prompt.md` / `user-profile-prompt.md` summariser prompts.
- `~/nanoclaw-v2-backups/openclaw-cron-jobs-20261004.json` — OpenClaw's cron jobs.
- `~/nanoclaw-v2-backups/instructions-20261004/` — every group's standing
  instructions before the cleanup.

Status: **open** (still to migrate), **done**, **replaced** (a v2 mechanism
covers it), **obsolete** (not worth porting, or never real).

---

## 1. Scheduled tasks — open (none were migrated)

`setup/migrate-v2/tasks.ts` skips a task whose `group_folder` has no v2 agent
group. v1's `main` became `dm-with-alanz`, so every active task was skipped,
silently; the migrator also knows nothing of `task_type`. The main group has no
scheduled tasks in v2.

Active in v1 (all on the main chat):

| v1 task                     | Schedule                  | What                                                                                                                                                                                                 | Port                                                                                                                                        |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-1776367857282-67z2x4` | `3 9 * * 6` (Sat)         | Synthesis-candidate scan: tag clusters ≥15 notes, notes ≥12 inbound links → `memory/digests/YYYY-MM-DD-synthesis-scan.md`, message the user. Bash gate script counts `tags:`/`links:` in `MEM-*.md`. | `ncl tasks create --script …` with the v1 prompt/script; `/workspace/group` → `/workspace/agent`, `memory_get` → `memory_get_file_content`. |
| `task-1776511133337-5u8wle` | `47 1 * * *`              | Nightly NanoClaw commit scan: watermark file + `git log` gate, digest to `memory/digests/`, `MEM-` note for architectural commits, message only for significant ones.                                | As above, plus a read-only mount of the v2 checkout (mount allowlist + `ncl groups config add-mount`); v2 mounts no project dir.            |
| `task-1776012215818-uahgqr` | `0 4 * * *`, idle ≥60 min | `task_type=session_reset`: archive and summarise the session into `memory/sessions/YYYY-MM-DD-HHmm.md` (`reset-prompt.md`), then clear it. Last v2-visible summary 2026-05-06.                       | No v2 task type. Needs a host module, or a prompt task given access to the session transcript. See §3.                                      |
| `task-1776625382556-zq1qam` | `7 9 * * 0`               | `task_type=user_profile`: synthesise `memory/USER.md` (<2000 tokens, `user-profile-prompt.md`), injected at session start.                                                                           | No v2 task type; pairs with §2.                                                                                                             |

Paused in v1, superseded by the researcher specialist — **obsolete**: the
Moltbook intake digest (`deltachat_intake`) and its copy-to-digests task.

OpenClaw crons never ported to v1:

- **Daily calendar sync** (`0 8 * * *`): fetch a private calendar ICS, summarise
  upcoming events. Was failing in OpenClaw (20 consecutive errors). **Open**, if
  still wanted.
- **RSS scan (blogwatcher)**: one feed, Guix Planet
  `https://planet.guix.gnu.org/atom.xml` — not in v1's feed list. **Open**, with §4.
- Memory index status, per-sender session check, Zotero enrich, Six Nations
  briefing — **obsolete**.

Not real: a "sources-mtime sweep cron" was described in the instructions as
possible, never created.

### What each task needs from v2 (checked 2026-10-04)

General: `ncl tasks` gate scripts run as `bash <file>` in the group's
container (image has bash/coreutils, `node`, `git`); `wakeAgent` data reaches
the prompt; a task session has the group's memory tools and may
`send_message` to the group's channel. The only task run logs on this install are one-shots from
August, before the rebuild onto upstream — prove the recurring, script-gated
path with `ncl tasks run <id>` before relying on it.

- **Synthesis scan — supported.** The v1 gate script, with
  `/workspace/group` → `/workspace/agent`, runs unchanged against today's notes
  (339 MEM, 3 SYN, wakes). Prompt edits: paths, `memory_get` →
  `memory_get_file_content`, and `memory_search` is keyword-only (§6).
- **Commit scan — done 2026-10-04, as the `nanoclaw change scan` task**
  (`47 1 * * *`, main group). Purpose: keep the agent aware of how the host
  platform it runs on is changing — what is running, not upstream's live
  branch.
  - Source: `~/nanoclaw-v2/.git` mounted read-only at
    `/workspace/extra/nanoclaw-git` (allowlisted). The `.git` dir only — the
    checkout holds `.env` and `data/`, and no `.env` value is in any commit.
    `git --git-dir=…` works as the container user without `safe.directory`.
  - Change record: commits reachable from `main` and the `backup/*` tags, minus
    upstream's history, deduplicated by (author date, subject) — each piece of
    work once, under its original commit, however often folds and rebases
    rewrite `main`. Relies on every rewrite tagging the old tip `backup/pre-*`.
  - Upstream: reported only when the stack's upstream base moves (a rebase onto
    a newer upstream), as the range now running.
  - The gate keeps a seen list in `/workspace/agent/.nanoclaw-changes-state.json`;
    the first run reports the last 7 days as a baseline.
- **User profile — the task is portable, the injection is not there.** A
  prompt task can rewrite `memory/USER.md` (v1 prompt; add the backup to
  `USER-<date>.md` the v1 host did). But v2 loads only `memory/index.md` and
  `memory/system/definition.md` at session start; the index's Core Memory is
  empty and does not link `USER.md` (last written 2026-05-06), so a profile
  would not reach a session. Needs §2: the profile in Core Memory, or a third
  loaded file.
- **Session reset + summary — not supported; needs a host mechanism, not a
  task.** v1's reset was a host action: skip unless the chat was idle ≥60 min,
  archive the transcript to `conversations/`, have a throwaway agent summarise
  it into `memory/sessions/` (`reset-prompt.md`), clear the session. In v2:
  - _Trigger:_ nothing resets on a schedule. The main group's conversation has
    run continuously since 2026-09-24; it ends only on rotation (14 days or
    12 MB, `claude-history.ts`) or a manual `/clear`.
  - _Idle check:_ a task runs in its own session and cannot see the chat's
    activity; the host can.
  - _Archive:_ PreCompact and rotation write to `conversations/`, but each
    write is the whole transcript since the session began, so the folder fills
    with growing, overlapping copies. `/clear` clears without archiving at all.
  - _Summary:_ nothing writes `memory/sessions/` (last 2026-05-06) and nothing
    reads it back (§2).
  - _Clear:_ only the runner's `/clear` (a chat message, answered "Session
    cleared." to the user) or rotation. A task cannot clear another session.
    The continuation lives in `outbound.db`, which the host must not write.

  A port needs, roughly: a host job that checks idleness, then wakes the main
  session with a reset instruction carried as a message — the agent writes the
  summary with its full context (or a throwaway reads the archived transcript),
  then the runner archives and clears quietly. That is a runner command or
  message kind beside `/clear`, plus `/clear` archiving first. Design first —
  this touches `sessions.allium`.

## 2. Session warm-start & user profile — open

**v1:** `src/session-warm-start.ts`: user profile (`memory/USER.md`, 8-day
staleness), recent A-MEM notes by recency, prior-session tail.

**v2:** SessionStart injects only `memory/index.md` and
`system/definition.md` (`container/agent-runner/src/memory/context.ts`).

## 3. Session summaries (throwaway sessions) — open

**v1:** `spawnThrowaway()` summarised long or reset sessions into
`memory/sessions/` with retry (`MAX_THROWAWAY_RETRIES` etc.); tools
`list_failed_summaries`, `retry_session_summary`, `report_session`.

**v2:** raw transcripts are archived to `conversations/` (PreCompact hook and
transcript rotation, `providers/claude-history.ts`) — **replaced** for the
transcript itself. The LLM summaries are not.

## 4. RSS feed monitoring — open

**v1:** `src/rss-monitor.ts` — per-feed polling, isolated summarising run,
append to the group's `rss-digest.md` (`## {ISO} — {feed}`), 500-GUID seen
list, tools `subscribe_rss` / `unsubscribe_rss` / `list_rss_feeds`. One feed:
Mozilla.ai `https://blog.mozilla.ai/feed/`, daily, no interest filter (the
interest matching existed but was never used). Last digest entry 2026-05-06.

**v2:** nothing. Either a module, or one gated `ncl tasks` task per feed (script
fetches and diffs GUIDs into a state file; prompt summarises and appends to
`rss-digest.md`). Add the OpenClaw Guix Planet feed (§1).

## 5. WebXDC apps — open

Previously listed as intentionally removed; reclassified 2026-10-04 as to
migrate.

**v1** (DeltaChat):

- `/todo` delivers `todo.xdc`, a checklist over the group's `todo.md`;
  toggles arrive as `[Action: todo_toggle = {...}] (surface: todo)`; the agent
  pushes state back with `webxdc_update`. Serialisation rules in v1 main
  `CLAUDE.md` (snapshot above).
- `/app` delivers `nanoclaw.xdc`, a WebXDC chat UI.
- `src/channels/webxdc-store.ts`: chat→message-id session map plus queued
  updates (`data/deltachat-webxdc.json`). Sources in `apps/todo-app/`,
  `webxdc-src/`; build scripts `build:todo-xdc`, `build:webxdc`; notes in
  `docs/webxdc-app-guide.md`.
- Tools `webxdc_update`, `webxdc_send_image`.

**v2:** `src/channels/deltachat.ts` labels an inbound WebXDC message and has no
other support. `todo.md` and `todo-state.json` are already in the main group
folder.

## 6. Memory — mostly done

Done: Gemini embeddings, TPM/RPM rate limiting, org-mode chunking,
`MEMORY_SEARCH_*` config, host-side hybrid merge, indexed mounts (the org
files).

Open:

- **The agent gets no vector search.** The container's `memory_search` is
  FTS/BM25 only (`container/agent-runner/src/mcp-tools/memory.ts`); the host's
  hybrid `handleMemorySearch` (`src/memory/search.ts`) is called only from tests.
- Query expansion (v1 `src/memory/query-expansion.ts`).
- `memory_search` applies `path_prefix` after its row limit, so a large source
  (the org files) can crowd a prefix's results out.

## 7. Zotero — sync done, search open

Sync and pre-check are real (`src/modules/zotero/`). Open: `search_zotero` —
`zotero-md/` sits at the group root, outside memory search, so agents can only
grep it. Index it (move under `memory/` or mark it as an indexed mount) or port
the tool.

## 8. Other MCP tools and chat commands

| v1                                                                          | Status                                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `memory_list`                                                               | done (`memory_list_files`)                                                                                        |
| `query_memory`, `submit_raw_memory`                                         | uncertain — possibly covered by the memory specialist                                                             |
| `search_zotero`                                                             | open (§7)                                                                                                         |
| `query_transcript` (paginated history query)                                | open                                                                                                              |
| `skill_eval`                                                                | open, low value                                                                                                   |
| `list_failed_summaries`, `retry_session_summary`, `report_session`          | open (§3)                                                                                                         |
| `webxdc_update`, `webxdc_send_image`                                        | open (§5)                                                                                                         |
| `set_reaction`, task tools                                                  | replaced (`add_reaction`, `ncl tasks`)                                                                            |
| `start_remote_control`, `stop_remote_control`                               | open (§9)                                                                                                         |
| `register_group`, `set_group_trusted`, `requiresTrigger`, `@Andy` trigger   | replaced (`ncl messaging-groups` / `ncl wirings` with `engage_mode`; privilege from `user_roles`) — operator-side |
| `/esc <context>`, `/reset`, `/retry-summary`, `/help`, `/app` chat commands | open (`/app` with §5)                                                                                             |
| `/compact`                                                                  | replaced (native admin command)                                                                                   |

## 9. Remote control — open

**v1:** `src/remote-control.ts`, tools `start_remote_control` /
`stop_remote_control`. **v2:** `/remote-control` is filtered
(`src/provider-contracts/claude.ts`).

## 10. Replaced or obsolete (no action)

- **Cross-group scheduling** (`target_group_jid`, `context_mode`):
  `ncl tasks create --group` from the host or `cli_scope=global`. Every v2 task
  runs in its own session; there is no chat-history mode, and no live v1 task
  needed one.
- **Sender allowlist** (`~/.config/nanoclaw/sender-allowlist.json`): never
  configured (the file does not exist). `unknown_sender_policy`,
  `sender_scope` and `agent_group_members` cover it. `SENDER_ALLOWLIST_PATH` in
  `src/config.ts` is an unread leftover.
- **Global folder** (`groups/global/`, `/workspace/global`): held only a shared
  `CLAUDE.md`; replaced by the composed base document. `/workspace/agent/shared/`
  was never real.
- **Agent teams**: still enabled for the main group
  (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), alongside specialists.
- **Ollama provider**: skills exist, never used in v1.
- **Configuration options**: specialist depth is `maxSpecialistDepth`,
  concurrency `MAX_CONCURRENT_CONTAINERS`; directory options are hardcoded; the
  throwaway options return with §3.
- **Telegram and intake groups**: unused.
- **Emacs channel**: optional — `/add-emacs` installs it.

---

## Priority order (suggested)

1. **Scheduled tasks** (§1) — mostly recreating tasks with `ncl tasks create`;
   the synthesis scan and commit scan are cheap.
2. **Vector search for agents** (§6) — memory search is keyword-only today.
3. **Session summaries + warm-start + user profile** (§2, §3) — continuity.
4. **RSS** (§4) — self-contained.
5. **WebXDC todo/app** (§5).
6. **Zotero search, `query_transcript`, remote control, chat commands** (§7–9).
