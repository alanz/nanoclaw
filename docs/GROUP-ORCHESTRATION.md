# NanoClaw Group Orchestration

How groups are registered, isolated, and coordinated — and how the main group acts as orchestrator.

---

## Overview

NanoClaw runs as a single Node.js process that manages multiple
**registered groups** — chats or channels across any messaging
platform (Telegram, WhatsApp, Slack, DeltaChat, etc.). Each group gets
its own isolated container (Apple VM), its own workspace, its own
session history, and its own `CLAUDE.md`. One special group, the
**main group**, has elevated privileges to register other groups,
schedule tasks for them, and see the full list of available chats.

This is the foundation for multi-agent orchestration: each group is
effectively a persistent, isolated agent with its own identity and
memory.

---

## Group Registration

Groups are stored in SQLite (`registered_groups` table) and loaded at startup. Each entry has:

| Field             | Purpose                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `jid`             | Channel-scoped chat ID (e.g. `tg:-1001234567890`, `dc:10`)             |
| `name`            | Display name                                                           |
| `folder`          | Workspace directory under `groups/` (e.g. `telegram_research-team`)    |
| `trigger`         | Word that activates the agent (e.g. `@Andy`)                           |
| `requiresTrigger` | Whether trigger word is needed (default: `true`)                       |
| `isMain`          | Elevated orchestrator privileges                                       |
| `trustedGroup`    | 1:1 mode — no trigger needed, session commands allowed from any sender |
| `containerConfig` | Optional extra volume mounts for the group's container                 |

The main group registers new groups by calling the `register_group`
MCP tool. The host picks this up via IPC, validates the folder path,
creates the workspace directory, and persists to SQLite.

---

## Isolation Model

Each group gets a fully isolated environment:

```
groups/
└── {folder}/
    ├── CLAUDE.md          # Group's system prompt and memory instructions
    ├── logs/              # Container logs per run
    ├── memory/            # Agent's long-term memory files
    └── ...                # Any files the agent creates
```

Inside the container, the group's workspace is mounted at
`/workspace/group` (read-write). The main group additionally gets
`/workspace/project` (the NanoClaw source, read-only).

A `global/` folder (`groups/global/`) is mounted read-only at
`/workspace/global` in every container — a shared knowledge base
readable by all groups, writable only by main.

**CLAUDE.md loading order** (innermost wins):

1. Base Claude Code system prompt
2. `/workspace/project/CLAUDE.md` (NanoClaw-wide instructions)
3. `/workspace/global/CLAUDE.md` (shared cross-group instructions)
4. `/workspace/group/CLAUDE.md` (the group's own prompt — fully customisable)

Sessions (conversation history) are persisted per group folder in
SQLite and restored when a container starts. Each group maintains its
own independent conversation thread.

---

## The Message Loop

`src/index.ts` runs a polling loop that:

1. Queries SQLite for new messages across all registered group JIDs
2. Groups messages by chat JID
3. For each group with new messages:
   - Checks trigger requirements and sender allowlist
   - If a container is already running for this group, **pipes** the formatted messages directly into it via stdin
   - Otherwise, **enqueues** a new container spawn via `GroupQueue`

The `GroupQueue` does fair round-robin scheduling — no group can
starve others. Each group's container runs one turn at a time.

---

## IPC: The Nervous System

Containers cannot call out to the host directly. Instead, the **MCP
server** running inside each container writes JSON files to a
namespaced IPC directory on the shared volume:

```
store/ipc/
└── {groupFolder}/
    ├── messages/      # send_message, send_file requests
    ├── tasks/         # schedule_task, register_group, subscribe_rss, etc.
    └── responses/     # Host replies to query_transcript, memory_search, etc.
```

`src/ipc.ts` polls all group IPC directories on a short interval and
dispatches each file. **Authorization is enforced by directory
identity** — which folder the file came from determines
`isMain`. Nothing inside the JSON payload is trusted for identity.

### Authorization rules

| Operation                              | Main group                 | Non-main group |
| -------------------------------------- | -------------------------- | -------------- |
| `send_message` to own chat             | ✓                          | ✓              |
| `send_message` to another group's chat | ✓                          | ✗              |
| `register_group`                       | ✓                          | ✗              |
| `set_group_trusted`                    | ✓                          | ✗              |
| `schedule_task` for own group          | ✓                          | ✓              |
| `schedule_task` for another group      | ✓ (via `target_group_jid`) | ✗              |
| `subscribe_rss` for another group      | ✓                          | ✗              |
| `query_transcript`                     | Own chat only              | Own chat only  |

### Request/response pattern

For synchronous-ish operations like `query_transcript` and
`memory_search`, the container writes a request file to `tasks/` and
then polls `responses/` with a 15-second timeout. The host reads the
request, does the work, and writes the response file. This avoids any
direct socket or RPC between container and host.

---

## The Main Group as Orchestrator

The main group is the only group that:

- Receives a **groups snapshot** at
  `/workspace/ipc/available_groups.json` listing every known chat with
  its registration status, name, and last activity time
- Can call `register_group` to activate a new group
- Can call `schedule_task` with `target_group_jid` to run a task in another group's context
- Can call `start_remote_control` / `stop_remote_control`

Every time main's agent runs, the host writes a fresh snapshot before
spawning the container. Non-main groups receive an empty array.

---

## Scheduled Tasks

Tasks are stored in SQLite and executed by `src/task-scheduler.ts`,
which polls for due tasks on a configurable interval.

### Schedule types

| Type       | `schedule_value` | Behaviour                                               |
| ---------- | ---------------- | ------------------------------------------------------- |
| `once`     | ISO timestamp    | Runs once at that time                                  |
| `interval` | Milliseconds     | Repeats, anchored to previous `next_run` to avoid drift |
| `cron`     | Cron expression  | Standard cron schedule in configured timezone           |

### Execution context

Each task has a `context_mode`:

- **`isolated`** (default) — fresh container with no session history. Clean slate, minimal context bleed.
- **`group`** — reuses the group's current live session ID. The agent picks up where the conversation left off.

Tasks run in the target group's container with that group's workspace,
CLAUDE.md, and mounts. They are full agent runs, not lightweight
callbacks.

After producing a result, a task container closes after 10 seconds (vs
30 minutes idle timeout for interactive sessions).

### Cross-group task scheduling

Main can schedule a task for any registered group:

```
schedule_task(
  prompt: "Summarise all research notes and write a digest to memory/digest.md",
  schedule_type: "once",
  schedule_value: "2026-03-24T09:00:00Z",
  target_group_jid: "tg:-1001234567890"
)
```

The task runs in that group's container, with its CLAUDE.md and
workspace. Results are sent to that group's chat via
`send_message`. There is no synchronous return path to main.

---

## Persistent Specialist Agents

Because each group has its own CLAUDE.md, workspace, and session,
NanoClaw groups are a natural fit for persistent specialist agents. A
`researcher` group might look like:

```
groups/researcher/
├── CLAUDE.md              # Role, expertise, research methodology
├── soul.md                # Core values and commitments
├── cognitive-profile.md   # Learned reasoning patterns
├── lessons.md             # Failure modes to avoid
├── active-work.md         # Current tasks and focus
└── memory/
    ├── MEMORY.md          # Index of long-term knowledge
    └── notes/             # Individual research notes
```

Main orchestrates it by scheduling tasks via `target_group_jid`. The
researcher agent maintains its own context across tasks, building up
domain knowledge over time.

### What's missing today

- **Agent-to-agent messaging** — groups cannot send messages to each
  other directly. All cross-group communication is brokered by main
  via scheduled tasks or files written to `groups/global/`.
- **Synchronous return values** — there's no way to get a result from
  a sub-group task back into main's current session. Results go to the
  target group's chat.
- **Per-group tool allowlists** — all groups currently get the same
  MCP tools.

---

## SDK Agent Teams vs NanoClaw Group Orchestration

These are two separate systems that serve different purposes:

|                   | SDK Agent Teams                                 | NanoClaw Groups                               |
| ----------------- | ----------------------------------------------- | --------------------------------------------- |
| **Isolation**     | None — shared container, CLAUDE.md, session     | Full — separate container, CLAUDE.md, session |
| **Persistence**   | Ephemeral — die with the session                | Persistent — survive restarts                 |
| **Context**       | All subagents inherit main group's full context | Each group has its own custom context         |
| **Communication** | Real-time via `SendMessage` tool                | Async via `schedule_task` + IPC               |
| **Use case**      | Parallel sub-tasks within one response          | Long-running specialist agents                |

SDK teams (enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) are
good for splitting a single task across parallel workers in real
time. NanoClaw groups are better for persistent agents with their own
identities, memories, and specialisations.

The **Telegram Swarm** skill (`/add-telegram-swarm`) is a presentation
layer on top of SDK teams — it routes each subagent's `send_message`
calls through a dedicated pool bot so users see different Telegram
identities per agent. It does not use NanoClaw group orchestration at
all.

---

## Key Source Files

| File                                          | Role                                                            |
| --------------------------------------------- | --------------------------------------------------------------- |
| `src/index.ts`                                | Message loop, `runAgent()`, group registration, snapshot writes |
| `src/ipc.ts`                                  | IPC watcher, message/task routing, authorization                |
| `src/task-scheduler.ts`                       | Due task polling, task execution, `computeNextRun()`            |
| `src/container-runner.ts`                     | Container spawn, volume mounts, IPC namespace setup             |
| `src/group-queue.ts`                          | Fair scheduling of group message processing                     |
| `src/db.ts`                                   | SQLite: groups, tasks, sessions, messages, RSS feeds            |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tools exposed to container agents                           |
| `groups/global/CLAUDE.md`                     | Shared instructions readable by all groups                      |
| `groups/{folder}/CLAUDE.md`                   | Per-group system prompt and memory protocol                     |
