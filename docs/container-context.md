# Container Context Reference

What context a container agent receives depends on two axes: **which
group owns the run** (main vs non-main), and **what triggered the
run** (interactive message, scheduled task, or RSS feed job).

---

## Common to all containers

Regardless of scenario, every container receives:

- **System prompt:** Claude Code `claude_code` preset
- **Working directory (`cwd`):** `/workspace/group`
- **Tools:** `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`, `TaskOutput`, `TaskStop`, `TeamCreate`, `TeamDelete`, `SendMessage`, `TodoWrite`, `ToolSearch`, `Skill`, `NotebookEdit`, `mcp__nanoclaw__*`
- **MCP server:** nanoclaw IPC server (scoped to the group's JID and folder)
- **Container skills:** `container/skills/` synced into `/home/node/.claude/skills/` at launch
- **Permissions:** `bypassPermissions` — no tool confirmation prompts
- **Settings (via `~/.claude/settings.json`):**
  - `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` — SDK loads CLAUDE.md from all accessible mounted directories, not just `cwd` and its parents
  - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`
- **Mounts (all groups):**
  | Host path | Container path | Access |
  |---|---|---|
  | `groups/{folder}/` | `/workspace/group` | rw |
  | `data/sessions/{folder}/.claude/` | `/home/node/.claude` | rw |
  | `data/sessions/{folder}/agent-runner-src/` | `/app/src` | rw |
  | `data/sessions/{folder}/tools/` | `/workspace/tools` | ro |
  | `data/ipc/{folder}/` | `/workspace/ipc` | rw |

---

## Main group

Triggered by an interactive message to the main channel (self-chat).

**Additional mount:**
| Host path | Container path | Access |
|---|---|---|
| Project root | `/workspace/project` | ro |

**No** `/workspace/global` mount.

**System prompt append:** none — preset only.

**CLAUDE.md loaded:** `groups/main/CLAUDE.md` via `cwd`. `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` has no additional effect since no extra directories are mounted.

**Session:** uses the group's current session — continuous conversation history.

**User identity:** container starts as root; entrypoint drops privileges to host uid/gid via `setpriv`.

---

## Non-main group

Triggered by an interactive message to any registered group other than main.

**No** `/workspace/project` mount.

**Additional mount (if `groups/global/` exists):**
| Host path | Container path | Access |
|---|---|---|
| `groups/global/` | `/workspace/global` | ro |

**System prompt append:** contents of `groups/global/CLAUDE.md` are explicitly read by the agent-runner and appended to the system prompt before the SDK query runs.

**CLAUDE.md loaded:** `groups/{folder}/CLAUDE.md` via `cwd`, and `groups/global/CLAUDE.md` again via the SDK (because `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` causes it to scan `/workspace/global`). Global memory is therefore loaded twice — once in the system prompt append, once as a CLAUDE.md file.

**Session:** uses the group's current session — continuous conversation history.

**User identity:** `--user uid:gid` flag passed directly to the container runtime.

---

## Scheduled task (cron / interval / one-time)

Runs in the context of the group that owns the task. Main vs non-main rules above apply for mounts and CLAUDE.md loading.

**Prompt:** the task's stored prompt, prepended with:

```
[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]
```

**Session:** determined by `context_mode`:

- `'group'` — uses the group's current session (has access to conversation history)
- anything else — `sessionId: undefined`, always isolated (fresh context)

**IPC snapshot written before launch:** `ipc/{folder}/current_tasks.json` — main sees all tasks, others see only their own.

**Container close:** 10 seconds after the first result is emitted.

---

## RSS feed job

Runs in the context of the group that owns the feed. Main vs non-main rules above apply for mounts and CLAUDE.md loading.

**Prompt:** built from the new feed items, prepended with the scheduled task header:

```
[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]

RSS feed update for "{feed title}" ({url}):

1. **{item title}**
   {link}
   {description snippet, max 300 chars, HTML stripped}
...
(up to 20 items)

---
[If feed.interest is set:]
The user is interested in: {interest}
Review the items above and notify the user of anything that matches their interests. Be concise...
If nothing matches, respond with nothing (empty reply).

[If no interest:]
Summarize these new RSS items briefly for the user.
```

**Session:** always `undefined` — every RSS run is isolated with no conversation history.

**IPC snapshot written before launch:** `ipc/{folder}/rss_feeds.json` — main sees all feeds, others see only their own.

**Container close:** 10 seconds after the first result is emitted.

---

## Summary table

|                                   | Main (interactive) | Non-main (interactive) | Scheduled task            | RSS feed  |
| --------------------------------- | ------------------ | ---------------------- | ------------------------- | --------- |
| `/workspace/project`              | ✓ ro               | —                      | per group                 | per group |
| `/workspace/global`               | —                  | ✓ ro                   | per group                 | per group |
| Global CLAUDE.md in system prompt | —                  | ✓                      | per group                 | per group |
| Session continuity                | ✓                  | ✓                      | optional (`context_mode`) | never     |
| `[SCHEDULED TASK]` header         | —                  | —                      | ✓                         | ✓         |
| IPC snapshot                      | tasks              | tasks                  | tasks                     | rss_feeds |
