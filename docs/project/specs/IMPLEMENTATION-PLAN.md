# Specialists Implementation Plan

Covers the three unimplemented specs: `null-channel.allium`, `specialists.allium`,
`delegation-policy.allium`. Work is ordered by dependency.

---

## ~~Phase 1 — Database schema~~ ✓ Done (commit 5de15c4)

**File:** `src/db.ts` (new tables added to `createSchema`)

Two new tables:

```sql
CREATE TABLE IF NOT EXISTS specialist_tasks (
  id TEXT PRIMARY KEY,
  specialist_type TEXT NOT NULL,        -- SpecialistType.name
  prompt TEXT NOT NULL,
  requester_group TEXT,                 -- group jid; null when requester_task is set
  requester_task_id TEXT,               -- specialist_tasks.id; null when requester_group is set
  depth INTEGER NOT NULL DEFAULT 0,
  chain_delegation_count INTEGER NOT NULL DEFAULT 1,
  ancestor_types TEXT NOT NULL DEFAULT '[]',  -- JSON array of SpecialistType names
  is_last_same_type_dispatch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',      -- queued|running|awaiting_sub_task|awaiting_restart|completed|failed
  pending_sub_task_id TEXT,             -- set when status = awaiting_sub_task
  result TEXT,                          -- set when status = completed
  failure_kind TEXT,                    -- set when status = failed
  failure_detail TEXT,
  restart_attempt_count INTEGER NOT NULL DEFAULT 0,
  delegated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS specialist_conversation_sessions (
  task_id TEXT PRIMARY KEY REFERENCES specialist_tasks(id),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'  -- active|stale|cleared
);
```

Also add DB helper functions: `createSpecialistTask`, `getSpecialistTask`,
`updateSpecialistTask`, `getSpecialistTasksByStatus`,
`createSpecialistSession`, `updateSpecialistSession`, `getSpecialistSession`.

**Tests:** extend `src/db.test.ts` with schema smoke tests for the new tables.

---

## ~~Phase 2 — Types and config~~ ✓ Done

**File:** `src/types.ts`

Add:

```ts
export interface SpecialistType {
  name: string;
  description: string;
  isMemoryProvider: boolean;
  lastTurnSubNotice?: string;
  lastTurnParentNotice?: string;
}

export type SpecialistTaskStatus =
  | 'queued' | 'running' | 'awaiting_sub_task'
  | 'awaiting_restart' | 'completed' | 'failed';

export type FailureKind =
  | 'cycle_detected' | 'depth_exceeded' | 'count_exceeded'
  | 'same_type_limit_exceeded' | 'timeout' | 'execution_error' | 'host_restart';

export interface SpecialistTask {
  id: string;
  specialistType: string;
  prompt: string;
  requesterGroup: string | null;
  requesterTaskId: string | null;
  depth: number;
  chainDelegationCount: number;
  ancestorTypes: string[];
  isLastSameTypeDispatch: boolean;
  status: SpecialistTaskStatus;
  pendingSubTaskId: string | null;
  result: string | null;
  failureKind: FailureKind | null;
  failureDetail: string | null;
  restartAttemptCount: number;
  delegatedAt: string;
  closedAt: string | null;
}
```

**File:** `src/config.ts`

Add `SPECIALISTS_CONFIG` constant (matches `specialists.allium` config block):

```ts
export const SPECIALISTS_CONFIG = {
  maxSpecialistDepth: 5,
  maxChainDelegations: 20,
  maxSameTypeDispatches: 3,
  maxTaskDurationMs: 4 * 60 * 60 * 1000,       // 4 hours
  containerTimeoutMs: 30 * 60 * 1000,           // 30 minutes
  maxRestartRetries: 2,
  maxStagingDurationMs: 2 * 60 * 60 * 1000,    // 2 hours
  defaultLastTurnSubNotice: '[Final iteration: this is your last opportunity to respond. Provide your best conclusive output as no further iterations will occur.]',
  defaultLastTurnParentNotice: '[Final iteration: no further responses will follow from this specialist. Incorporate this as your final input and conclude your work.]',
};
```

Specialist type registry lives in a config file (`specialists.json` in the repo root or
DATA_DIR). Format: array of `SpecialistType`. Loaded once at startup. Adding a new type
requires a service restart (as per spec).

---

## Phase 3 — NullChannel

**New file:** `src/channels/null-channel.ts`

Implements the `Channel` interface. No I/O:

- `connect()` / `disconnect()` — resolve immediately
- `isConnected()` — always `true`
- `ownsJid(jid)` — `jid.startsWith('specialist:')`
- `sendMessage()` — silent no-op (discards; does not log)

Exports:
- `NullChannel` class
- `NULL_CHANNEL_JID_PREFIX = 'specialist:'`
- `makeSpecialistJid(taskId: string): string` — `'specialist:' + taskId`

Self-registers: `registerChannel('null-channel', () => new NullChannel())`.

**File:** `src/channels/index.ts` — add `import './null-channel.js'`

**Tests:** implement the `it.todo()` stubs in `src/channels/null-channel.test.ts`.

This phase is self-contained and can be done before `specialists.ts` is written.

---

## Phase 4 — Delegation policy

**New file:** `src/delegation-policy.ts`

Exports:
- `DelegationDecision` type
- `checkDelegationPolicy(parentTask: SpecialistTask, targetType: SpecialistType): DelegationDecision`

Pure function (no DB calls). Implements the four-check priority order from
`delegation-policy.allium`:

1. Cycle detection — `targetType.name in parentTask.ancestorTypes`
2. Depth limit — `parentTask.depth + 1 >= SPECIALISTS_CONFIG.maxSpecialistDepth`
3. Chain count — `parentTask.chainDelegationCount >= SPECIALISTS_CONFIG.maxChainDelegations`
4. Same-type limit — `sameTypeDispatchCount(parentTask, targetType) >= SPECIALISTS_CONFIG.maxSameTypeDispatches`

`sameTypeDispatchCount` requires a DB query (counts prior non-policy-rejected tasks from
parent to target type). Make it an async parameter injected by the caller so the function
stays testable without a DB.

Signature that keeps the function pure:
```ts
checkDelegationPolicy(
  parentTask: SpecialistTask,
  targetType: SpecialistType,
  sameTypeCount: number,         // computed by caller from DB
): DelegationDecision
```

A separate helper `getSameTypeDispatchCount(parentTaskId, targetTypeName): Promise<number>`
lives in `src/specialists.ts` (does the DB query with the right exclusion logic).

**Tests:** implement the `it.todo()` stubs in `src/delegation-policy.test.ts`.

---

## Phase 5 — Specialist core (`src/specialists.ts`)

**New file:** `src/specialists.ts`

Responsibilities:

### 5a. Type registry
Load `SpecialistType[]` from config at startup. Export `getSpecialistType(name)` and
`getAllSpecialistTypes()`.

### 5b. Task dispatch (from main group)
`dispatchSpecialistTask(mainGroupJid, specialistTypeName, prompt): Promise<SpecialistTask>`

Creates DB row, assigns synthetic JID via `makeSpecialistJid(task.id)`, enqueues
container run. Corresponds to `MainDispatchesSpecialistTask` rule.

### 5c. Sub-task dispatch (from running specialist via IPC)
`handleSubTaskRequest(parentTaskId, targetTypeName, prompt, sessionId): Promise<{ ok: true } | { ok: false; rejection: DelegationDecision }>`

- Looks up parent task, verifies `status = running`
- Calls `getSameTypeDispatchCount` then `checkDelegationPolicy`
- If allowed: creates sub-task, transitions parent to `awaiting_sub_task`, saves session_id
- If rejected: creates a failed task record, returns rejection to IPC caller (parent stays running)

Corresponds to `SpecialistDispatchesSubTask` + `SubTaskRejected*` rules.

### 5d. Memory query dispatch
`handleMemoryQuery(queryingTaskId, prompt, sessionId): Promise<void>`

Like sub-task dispatch but skips delegation policy. Corresponds to `SpecialistQueriesMemory`.

### 5e. Result delivery
`handleSpecialistResult(taskId, resultText): Promise<void>`

Marks task `completed`, clears session, triggers requester notification:
- `requesterGroup` set → post result into main group's message queue
- `requesterTask` set → call `resumeParentSpecialist(parentTask, completedTask)`

Corresponds to `SpecialistTaskCompleted` + `ParentSpecialistResumed`.

### 5f. Failure propagation
`failSpecialistTask(taskId, kind, detail): Promise<void>`

Marks task `failed`, clears session, propagates via same requester routing as result delivery.

### 5g. Session tracking
`handleSessionReport(taskId, sessionId): Promise<void>` — upserts `specialist_conversation_sessions`.

Corresponds to `SpecialistSessionEstablished`.

### 5h. Container lifecycle
`startSpecialistContainer(task: SpecialistTask, inject?: SpecialistTask): Promise<void>`

Calls `runContainerAgent` with:
- Group folder for the specialist type (e.g. `specialists/researcher`)
- Synthetic JID as groupJid
- Session ID from conversation session (if exists and task status is `awaiting_sub_task` or `awaiting_restart`)
- Injected sub-task result in initial prompt (if `inject` is set)
- Last-turn notice prepended to prompt when `task.isLastSameTypeDispatch = true`
- Per-invocation timeout = `SPECIALISTS_CONFIG.containerTimeoutMs`

### 5i. Startup recovery
`recoverSpecialistTasksOnStartup(): Promise<void>` — called from `src/index.ts` during startup.

For tasks with `status = running`:
- `restartAttemptCount < maxRestartRetries` → increment count, transition to `awaiting_restart`, start container (cold restart, inject: null)
- Otherwise → fail with `host_restart`

For tasks with `status = awaiting_sub_task` where `pendingSubTask` is terminal:
- Re-trigger `resumeParentSpecialist` (sub-task result already available)

Corresponds to `SpecialistTaskScheduledForRetry`, `SpecialistTaskFailedAfterRetriesExhausted`,
`SpecialistTaskSubResultAvailableAfterRestart`.

**Tests:** implement `src/specialists.test.ts` stubs (already committed).

---

## Phase 6 — IPC integration

**File:** `src/ipc.ts`

Add new IPC command cases (handled in `processIpcCommand`):

| Command | Handler |
|---------|---------|
| `dispatch_specialist` | `handleSubTaskRequest(parentTaskId, targetType, prompt, sessionId)` |
| `query_memory_specialist` | `handleMemoryQuery(taskId, prompt, sessionId)` |
| `deliver_specialist_result` | `handleSpecialistResult(taskId, resultText)` |
| `report_specialist_session` | `handleSessionReport(taskId, sessionId)` |
| `submit_raw_memory` | write file to staging path + notify main group |

These IPC commands are emitted by specialist containers via the existing filesystem IPC
mechanism. The specialist container CLAUDE.md / MCP tools will need corresponding tool
definitions (see Phase 7).

---

## Phase 7 — Container MCP tools

**Directory:** `container/agent-runner/src/` (MCP server inside containers)

Add MCP tools that specialist containers can call:

| Tool | Maps to IPC command |
|------|---------------------|
| `dispatch_specialist` | `dispatch_specialist` |
| `query_memory` | `query_memory_specialist` |
| `deliver_result` | `deliver_specialist_result` |
| `report_session` | `report_specialist_session` |
| `submit_raw_memory` | `submit_raw_memory` |

These write to the group's IPC directory (`/workspace/ipc/`) in the same JSON format
as existing tools (e.g. `schedule_task`).

After changes here, run `./container/build.sh` to rebuild the agent image.

---

## Phase 8 — Specialist group folders

Each specialist type needs a group folder under `groups/specialists/{name}/` with:
- `CLAUDE.md` — role description, constraints, available tools
- `memory/` directory (created on first run)

The `dispatchSpecialistTask` function (Phase 5b) creates the folder if absent, copying
a template from `container/skills/specialist-template/`.

Memory-provider specialists get read-only access to the main group workspace mounted at
`/workspace/extra/main-memory` (handled in `startSpecialistContainer`).

---

## Phase 9 — Wire-up in orchestrator

**File:** `src/index.ts`

1. Call `recoverSpecialistTasksOnStartup()` during the startup sequence (after DB init,
   before the message loop starts).
2. When a specialist result targets `requesterGroup` (main group), post it as a synthetic
   inbound message or inject it directly into the pending agent context — same mechanism
   used by `deliver_result` for orchestration cycles.
3. Export a `dispatchSpecialistTask` entry point for the main group agent to call via IPC.

---

## Implementation order

```
Phase 1 (DB schema)
  ↓
Phase 2 (Types + config)
  ↓
Phase 3 (NullChannel) ←── self-contained; tests can pass at this point
  ↓
Phase 4 (Delegation policy) ←── pure function; no DB needed for unit tests
  ↓
Phase 5 (specialists.ts core)
  ↓
Phase 6 (IPC integration)
  ↓
Phase 7 (MCP tools in container) ←── requires container rebuild
  ↓
Phase 8 (Group folders + template)
  ↓
Phase 9 (Orchestrator wire-up)
```

Phases 3 and 4 can proceed in parallel once Phase 2 is done.
Phases 7 and 8 can proceed in parallel once Phase 5 is done.

---

## Open questions (to resolve during implementation)

1. **Specialist result injection into main group** — should results be posted as a synthetic
   inbound message (going through the normal message loop) or injected directly into the
   pending `ContainerInput`? The orchestration cycle precedent uses a direct inject; that
   is likely the right model here too.

2. **GroupQueue slot management for specialists** — the spec leaves this open. Initial
   implementation: each specialist task gets its own synthetic JID and GroupQueue slot,
   with no additional concurrency cap. Revisit if contention becomes a problem.

3. **Specialist type config file location** — `DATA_DIR/specialists.json` or a checked-in
   `config/specialists.json`? The latter is more auditable; the former is easier for
   skill-based addition. Decision deferred to Phase 5a.

4. **`nanoclaw.allium` `ChannelType` enum** — currently lists `telegram | deltachat | emacs`.
   Should add `null_channel` once NullChannel is implemented. Low priority; the enum is
   informational in the spec.
