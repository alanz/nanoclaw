# V1 → V2 Migration Gaps

Features present in v1 (`~/nanoclaw`), or carried into v1 from OpenClaw
(`~/.openclaw`), that are not yet in v2. The migration is incomplete: an item
listed here as open is meant to be restored, not dropped, unless it is marked
obsolete.

Audited 2026-10-04, when the main agent's standing instructions were cleaned
of every v1-era section describing a feature v2 lacks (each removed section is
accounted for below), and again 2026-10-12 in a deep-dive comparison of v1 and
v2 across five areas (agent tools, channels, memory/specialists/Zotero/web UI,
groups/config/ops, host core). That audit's findings — most fixed the same
day — are in §11; its corrections to this register are folded into §1–§10.
Register updated 2026-10-13. v1 stopped on 2026-06-16 and is not running.

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

## 1. Scheduled tasks — partly done (commit scan, session reset); synthesis scan and user profile open

`setup/migrate-v2/tasks.ts` skips a task whose `group_folder` has no v2 agent
group. v1's `main` became `dm-with-alanz`, so every active task was skipped,
silently; the migrator also knows nothing of `task_type`. The main group has no
scheduled tasks in v2.

Active in v1 (all on the main chat):

| v1 task                     | Schedule                  | What                                                                                                                                                                                                 | Port                                                                                                                                        |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-1776367857282-67z2x4` | `3 9 * * 6` (Sat)         | Synthesis-candidate scan: tag clusters ≥15 notes, notes ≥12 inbound links → `memory/digests/YYYY-MM-DD-synthesis-scan.md`, message the user. Bash gate script counts `tags:`/`links:` in `MEM-*.md`. | `ncl tasks create --script …` with the v1 prompt/script; `/workspace/group` → `/workspace/agent`, `memory_get` → `memory_get_file_content`. |
| `task-1776511133337-5u8wle` | `47 1 * * *`              | Nightly NanoClaw commit scan: watermark file + `git log` gate, digest to `memory/digests/`, `MEM-` note for architectural commits, message only for significant ones.                                | **Done 2026-10-04** as `nanoclaw change scan` (below).                                                                                      |
| `task-1776012215818-uahgqr` | `0 4 * * *`, idle ≥60 min | `task_type=session_reset`: archive and summarise the session into `memory/sessions/YYYY-MM-DD-HHmm.md` (`reset-prompt.md`), then clear it. Last v2-visible summary 2026-05-06.                       | **Done 2026-10-06** by the host module `src/modules/session-reset/` (§3).                                                                   |
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
  `memory_get_file_content`. (`memory_search` has been hybrid since
  2026-10-11, §6.) Not yet created.
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
- **Session reset + summary — DONE 2026-10-06** by the host module
  `src/modules/session-reset/` (design: [session-reset-design.md](session-reset-design.md),
  spec `specs/session-reset.allium`). The analysis below is kept as the record.
  **Was: not supported; needs a host mechanism, not a
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

## 3. Session summaries (throwaway sessions) — done 2026-10-06

Now written by `src/modules/session-reset/` for every ended chat conversation
(daily reset, `/clear`, rotation): a one-shot task per archive, 3 attempts, then a
`-failed.md` placeholder. See [session-reset-design.md](session-reset-design.md).

**v1:** `spawnThrowaway()` summarised long or reset sessions into
`memory/sessions/` with retry (`MAX_THROWAWAY_RETRIES` etc.); tools
`list_failed_summaries`, `retry_session_summary`, `report_session`.

**Before 2026-10-06, v2** archived raw transcripts to `conversations/`
(PreCompact hook and transcript rotation, `providers/claude-history.ts`) but
wrote no summaries; the module now does both. The list/retry tools are not
ported (§8).

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

## 6. Memory — done; two small items open

Done: Gemini embeddings, TPM/RPM rate limiting, org-mode chunking,
`MEMORY_SEARCH_*` config, host-side hybrid merge, indexed mounts (the org
files), and:

- **Vector search for agents — done 2026-10-11.** The container's
  `memory_search` asks the host, which answers with the hybrid search (vector +
  keyword); keyword-only only when the host cannot answer in time.
- **`path_prefix` / `source` filters — done 2026-10-11**, applied in SQL before
  the row limit, so a large source no longer crowds a prefix out.
- **Index upkeep — done 2026-10-13** ([memory-index-remediation-plan.md](memory-index-remediation-plan.md)):
  no full re-index at every start (only when the index settings change, logged
  and shown on the dashboard), per-file transactions, vector repair (12,334
  orphan vectors from the v1-era index removed), cache pruning, Gemini
  timeouts/retries; the central `memory_files` / `memory_chunks` mirror retired
  (spec `memory.allium` updated).

Obsolete: query expansion (v1 `src/memory/query-expansion.ts` was dead code).

Open:

- `memory_search` lost v1's `include_content` option (full file content with
  the hits).
- **The memory specialist has no ranked search** — it greps. Giving it the
  hybrid search is a `memory.allium` change, so the owner's decision.

## 7. Zotero — sync and search done; search filters open

Sync and pre-check are real (`src/modules/zotero/`), and since 2026-10-11
`zotero-md/` is indexed for memory search as source `zotero`, with hourly
abstract enrichment. Open: v1 `search_zotero`'s filters — year, tag,
has-abstract. Today an agent searches with `source: "zotero"` and filters by
reading the frontmatter.

## 8. Other MCP tools and chat commands

| v1                                                                        | Status                                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `memory_list`                                                             | done (`memory_list_files`)                                                                                                 |
| `memory_search` `include_content`                                         | open (§6)                                                                                                                  |
| `query_memory`                                                            | replaced (`dispatch_sub_task` to the memory specialist)                                                                    |
| `submit_raw_memory`                                                       | obsolete (never used)                                                                                                      |
| `search_zotero`                                                           | done but its filters (§7)                                                                                                  |
| `query_transcript` (paginated history query)                              | open                                                                                                                       |
| `skill_eval`                                                              | open, low value                                                                                                            |
| `list_failed_summaries`, `retry_session_summary`                          | partly replaced: a summary that fails 3 times leaves a `-failed.md` placeholder (§3); no list/retry tool — open, low value |
| `report_session`                                                          | replaced (it was a resume hand-off; v2 does it internally)                                                                 |
| `deliver_result`, `dispatch_specialist_task`                              | replaced (`deliver_specialist_result`, `dispatch_specialist` / `dispatch_sub_task`)                                        |
| `brave_web_search`                                                        | done                                                                                                                       |
| `get_file_url`                                                            | done, without v1's `view` parameter                                                                                        |
| ollama tools                                                              | obsolete here (never used); `/add-ollama-tool` installs them                                                               |
| `webxdc_update`, `webxdc_send_image`                                      | open (§5)                                                                                                                  |
| `set_reaction`, task tools                                                | replaced (`add_reaction`, `ncl tasks`)                                                                                     |
| `start_remote_control`, `stop_remote_control`                             | open (§9)                                                                                                                  |
| `register_group`, `set_group_trusted`, `requiresTrigger`, `@Andy` trigger | replaced (`ncl messaging-groups` / `ncl wirings` with `engage_mode`; privilege from `user_roles`) — operator-side          |
| `/reset`                                                                  | replaced (native admin command, an alias of `/clear`)                                                                      |
| `/esc <context>`                                                          | partly covered                                                                                                             |
| `/retry-summary`                                                          | open, with the row above                                                                                                   |
| `/help`                                                                   | open (filtered as a native command today)                                                                                  |
| `/app`                                                                    | open (§5)                                                                                                                  |
| `/compact`                                                                | replaced (native admin command)                                                                                            |
| skills `/capabilities`, `/status`, `pdf-reader`                           | open (not in `container/skills/`)                                                                                          |

## 9. Remote control — open

**v1:** `src/remote-control.ts`, tools `start_remote_control` /
`stop_remote_control`. **v2:** `/remote-control` is filtered
(`src/provider-contracts/claude.ts`); the 2026-10-12 audit found host and
container disagreeing on it, to settle with the port.

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
- **Agent teams**: turned off 2026-10-12 for every group (v2 blocks
  `SendMessage`, so they could not work); specialists replace them. The
  settings backups are in `~/nanoclaw-v2-backups/agent-teams-off-20261012/`.
- **Ollama provider**: skills exist, never used in v1.
- **Configuration options**: specialist depth is `maxSpecialistDepth`,
  concurrency `MAX_CONCURRENT_CONTAINERS`; directory options are hardcoded; the
  throwaway options return with §3.
- **Telegram and intake groups**: unused. The 17 v1 intake-group files: no
  action (owner, 2026-10-12 — the one that mattered, HyperDoc, is being
  re-researched). Test groups dc:11 and dc:12: obsolete.
- **v1 `store/messages.db`** (2,221 messages, v1 specialist task history):
  not carried over (owner, 2026-10-12).
- **Emacs channel**: never used; `/add-emacs` installs it if wanted.
- **Dashboard chat tab, router-state view, proxy/Claude request counters**: not
  brought back — v2's dashboard is read-only by design, and the native
  credential proxy does not count requests.

## 11. Found by the 2026-10-12 audit

Gaps the register did not list. Fixed the same day unless marked (commit
subjects; hashes change when the patch stack is folded).

| Finding                                                                                                                                          | Status                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeltaChat 💭 re-sent every 4 s (777 against 343 replies); a late 💭 could land on ✅; no ✅ when a turn ended without a reply                    | fixed — "send each status reaction once per message", "mark a message ✅ when its turn ends without a reply"                                               |
| Container image lacked python3, jq, ripgrep, sqlite3, imagemagick, zip                                                                           | fixed — "ship the general CLI kit agents expect"                                                                                                           |
| Agent teams enabled but unable to work                                                                                                           | fixed — turned off (§10)                                                                                                                                   |
| DeltaChat attachments over 5 MB never reached the agent; no media-type label                                                                     | fixed — "pass on attachments up to 64 MB, labelled by kind" (not yet seen live with a large file)                                                          |
| Idle containers held concurrency slots for 30 min (v1: 5 min, or at once when work was queued)                                                   | fixed — "reap idle containers sooner — chat 10 min, tasks at once" (`CONTAINER_IDLE_MS`, `TASK_CONTAINER_IDLE_MS`)                                         |
| No in-chat progress (v1: "⏳ Using X…")                                                                                                          | fixed — a DeltaChat progress line from the first tool status, removed on reply                                                                             |
| v1's ⏳/📝 compaction reactions                                                                                                                  | open                                                                                                                                                       |
| Container logs lost when a container exits                                                                                                       | fixed — one run log per container run, under the session's `logs/`                                                                                         |
| A failed specialist reported only a one-line error                                                                                               | fixed — "tell the requester what a failed specialist was doing"                                                                                            |
| Dashboard lost the Specialists page, Tasks tab, index-health panel; graph's Research Task link dead                                              | fixed — Specialists page, Tasks tab, Memory Index panel (extended 2026-10-13), link works                                                                  |
| Dead `qmd` container skill shipped to every group                                                                                                | fixed — dropped                                                                                                                                            |
| Nothing pruned the borg repo                                                                                                                     | fixed 2026-10-12/13 — v1 archives pruned to the last one; v2 retention (a week hourly, 14 daily, 8 weekly, 12 monthly) pruned daily by `scripts/backup.sh` |
| Memory index rewritten at every host start (~1.6 GB borg delta per restart)                                                                      | fixed 2026-10-13 (§6)                                                                                                                                      |
| Nothing prunes session transcripts; `scripts/cleanup-sessions.sh` is a dead v1 leftover                                                          | open                                                                                                                                                       |
| Memory specialist has no ranked search; `memory_search` lost `include_content`; Zotero search lost its filters                                   | open (§6, §7)                                                                                                                                              |
| `/capabilities`, `/status`, `pdf-reader` skills missing                                                                                          | open (§8)                                                                                                                                                  |
| `get_file_url` lost `view`; `TaskOutput` not in the tool allowlist                                                                               | open, small                                                                                                                                                |
| 👀 sent in unwired DeltaChat chats; edits of media messages dropped; `/chatid` poorer; a task's output can add ✅ to an already-answered message | open, small                                                                                                                                                |
| `nonMainReadOnly` warning on every start: a stale v1 key in `~/.config/nanoclaw/mount-allowlist.json`                                            | open, harmless — remove the key                                                                                                                            |
| v1's gate-script cost guidance missing from the instructions (suspected)                                                                         | open, to check                                                                                                                                             |
| `MemoryNoteArchived` (`memory-graph.allium`) not implemented                                                                                     | open — spec gap                                                                                                                                            |
| Only if a DeltaChat group is ever wired: mention mode cannot detect "@Andy"; v1's revoke-trust-on-member-join not ported                         | open, latent                                                                                                                                               |
| The main agent's `/workspace/project` mount and read-write `messages.db`                                                                         | dropped on purpose (v2 isolation)                                                                                                                          |

---

## Priority order (suggested)

1. **Synthesis scan** (§1) — a recurring task; the v1 gate script runs as is.
2. **User profile + warm-start** (§1, §2) — continuity.
3. **RSS** (§4) — self-contained; add the Guix Planet feed.
4. **WebXDC todo/app** (§5).
5. **Session transcript pruning** (§11).
6. **Smaller search gaps** — `include_content`, Zotero filters, the memory
   specialist's ranked search (spec decision) (§6, §7).
7. **`query_transcript`, remote control, `/help` and the missing skills** (§8, §9).
8. The small DeltaChat and tool items in §11.
