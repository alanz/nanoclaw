// Tests generated from specs/specialists.allium (allium plan: 195 obligations)
// The specialists module is not yet implemented. Every test here is a stub
// (it.todo) that documents an obligation from the spec. Remove the .todo suffix
// and wire to the implementation as each piece is built.
//
// Spec: specialists.allium — SpecialistTask lifecycle, delegation from main
// group, sub-task dispatch, chain limit enforcement, IPC file handover,
// container crash/restart recovery.
//
// Covered obligation categories:
//   enum_comparable (5)      config_default (10)     entity_fields (7)
//   value_equality (2)       entity_optional (5)     entity_relationship (1)
//   when_presence (4)        derived (1)             invariant (12)
//   transition_edge (22)     transition_rejected (5) transition_terminal (5)
//   rule_success (27)        rule_failure (78)       rule_entity_creation (11)
//
// Implementation entry points to create:
//   src/modules/specialists/db.ts        — SpecialistTask, IpcOutMount,
//                                          IpcInMount, ContainerTransfer,
//                                          TransferFile CRUD
//   src/modules/specialists/dispatch.ts  — dispatchSpecialist,
//                                          dispatchSubTask, chain guards
//   src/modules/specialists/delivery.ts  — deliverResult, commitToMemory,
//                                          ipc-in placement, result routing
//   src/modules/specialists/recovery.ts  — crash detection, restart logic,
//                                          timeout sweep
//   src/modules/specialists/config.ts    — SpecialistsConfig with defaults
//
// TODO: import these once they exist:
// import { SPECIALISTS_CONFIG } from './config.js';
// import { SpecialistTaskStatus, ... } from './types.js';
// import { dispatchSpecialist, dispatchSubTask, ... } from './dispatch.js';
// import { createSpecialistTask, ... } from './db.js';

import { describe, it } from 'vitest';

// ---------------------------------------------------------------------------
// Enums — obligation ids: enum-comparable.*
// All five enums must be stored as comparable values (typically string literals
// or numeric constants). Tests confirm the canonical member set and that
// values can be equality-compared.
// ---------------------------------------------------------------------------

describe('SpecialistTaskStatus enum', () => {
  it.todo('has members: queued, running, awaiting_sub_task, awaiting_restart, completed, failed');
  it.todo('values are comparable with ===');
});

describe('SpecialistFailureKind enum', () => {
  it.todo(
    'has members: cycle_detected, depth_exceeded, count_exceeded, same_type_limit_exceeded, timeout, execution_error, host_restart',
  );
  it.todo('values are comparable with ===');
});

describe('IpcMountStatus enum', () => {
  it.todo('has members: active, cleared');
  it.todo('values are comparable with ===');
});

describe('TransferStatus enum', () => {
  it.todo('has members: pending, in_transit, committed, expired');
  it.todo('values are comparable with ===');
});

describe('TransferFileStatus enum', () => {
  it.todo('has members: staged, owned, placed, expired');
  it.todo('values are comparable with ===');
});

// ---------------------------------------------------------------------------
// Value types — obligation ids: value-equality.*, entity-fields.*
// ---------------------------------------------------------------------------

describe('TaskFailure value type', () => {
  it.todo('has fields: kind (SpecialistFailureKind), detail (string)');
  it.todo('two TaskFailure objects with the same fields are structurally equal');
  it.todo('two TaskFailure objects with different fields are not equal');
});

describe('Invocation value type', () => {
  it.todo('has fields: id (string), session (Session), task (SpecialistTask | null)');
  it.todo('task is nullable — Invocation for a main-group run has task = null');
  it.todo('two Invocation objects with the same fields are structurally equal');
});

// ---------------------------------------------------------------------------
// Config defaults — obligation ids: config-default.*
// ---------------------------------------------------------------------------

describe('specialists config defaults', () => {
  it.todo('max_specialist_depth defaults to 5');
  it.todo('max_chain_delegations defaults to 20');
  it.todo('max_same_type_dispatches defaults to 3');
  it.todo('max_task_duration defaults to 4 hours (14_400_000 ms)');
  it.todo('max_restart_retries defaults to 2');
  it.todo('default_last_turn_sub_notice is the "[Final iteration: this is your last opportunity...]" string');
  it.todo('default_last_turn_parent_notice is the "[Final iteration: no further responses...]" string');
  it.todo('ipc_out_container_path defaults to "/workspace/ipc-out"');
  it.todo('ipc_in_container_path defaults to "/workspace/ipc-in"');
  it.todo('memory_reports_subpath defaults to "memory/reports"');
});

// ---------------------------------------------------------------------------
// SpecialistTask — entity fields, optional fields, when-presence fields,
// derived values, invariants
// obligation ids: entity-fields.SpecialistTask, entity-optional.*, when-presence.*, derived.*
// ---------------------------------------------------------------------------

describe('SpecialistTask entity', () => {
  describe('required fields', () => {
    it.todo(
      'has: specialist_group, prompt, depth, chain_delegation_count, ancestor_groups, is_last_same_type_dispatch, status, dispatched_at, restart_attempt_count',
    );
  });

  describe('optional fields — obligation ids: entity-optional.SpecialistTask.*', () => {
    it.todo('requester_group is nullable (root task has requester_group set, sub-task has null)');
    it.todo('requester_task is nullable (root task has requester_task null)');
    it.todo('closed_at is nullable until the task reaches a terminal state');
    it.todo('committed_files is nullable even when status = completed (text-only delivery)');
  });

  describe('state-dependent fields — obligation ids: when-presence.SpecialistTask.*', () => {
    it.todo('pending_sub_task is present when status = awaiting_sub_task');
    it.todo('pending_sub_task is absent (or throws) when status != awaiting_sub_task');
    it.todo('result is present when status = completed');
    it.todo('result is absent (or throws) when status != completed');
    it.todo('committed_files is present when status = completed');
    it.todo('committed_files is absent (or throws) when status != completed');
    it.todo('failure is present when status = failed');
    it.todo('failure is absent (or throws) when status != failed');
  });

  describe('derived value is_overdue — obligation id: derived.SpecialistTask.is_overdue', () => {
    it.todo('is_overdue is false when status is completed');
    it.todo('is_overdue is false when status is failed');
    it.todo('is_overdue is false when dispatched_at is recent (< max_task_duration ago)');
    it.todo('is_overdue is true when status is queued and dispatched_at is > max_task_duration ago');
    it.todo('is_overdue is true when status is running and dispatched_at is > max_task_duration ago');
    it.todo('is_overdue is true when status is awaiting_sub_task and dispatched_at is > max_task_duration ago');
    it.todo('is_overdue is true when status is awaiting_restart and dispatched_at is > max_task_duration ago');
    // Temporal test note: inject a controllable clock when implementing this check;
    // do not sleep against wall-clock time in tests.
  });

  describe('invariants — obligation ids: invariant.SpecialistTask.*', () => {
    it.todo('ExactlyOneRequester: exactly one of requester_group or requester_task is non-null');
    it.todo('ExactlyOneRequester: both null is invalid');
    it.todo('ExactlyOneRequester: both non-null is invalid');
    it.todo('DepthMatchesAncestorCount: depth = ancestor_groups.length');
    it.todo('DepthMatchesAncestorCount: root task has depth=0 and ancestor_groups={}');
    it.todo('SpecialistGroupMustBeSpecialist: specialist_group must have a Specialist row');
  });
});

// ---------------------------------------------------------------------------
// Global invariants — obligation ids: invariant.SpecialistDispatchMainGroupOnly,
// invariant.NoCycleInLiveTask, invariant.MemoryProviderDoesNotDelegate,
// invariant.TransferFilesMatchCount, invariant.TransferFilesBelongToTransfer,
// invariant.IpcOutMountPerInvocation, invariant.IpcInMountPerInvocation
// ---------------------------------------------------------------------------

describe('global invariants', () => {
  it.todo('SpecialistDispatchMainGroupOnly: only the main group (is_main=true) may dispatch root specialist tasks');
  it.todo('NoCycleInLiveTask: no live (non-terminal) SpecialistTask has has_cycle=true');
  it.todo('MemoryProviderDoesNotDelegate: a memory-provider specialist cannot itself call dispatch_sub_task');
  it.todo('TransferFilesMatchCount: ContainerTransfer.file_count = transfer.files.length');
  it.todo('TransferFilesBelongToTransfer: every TransferFile.transfer points to the owning ContainerTransfer');
  it.todo('IpcOutMountPerInvocation: at most one active IpcOutMount per invocation');
  it.todo('IpcInMountPerInvocation: at most one active IpcInMount per invocation');
});

// ---------------------------------------------------------------------------
// SpecialistTask state machine — obligation ids: transition-edge.*, transition-rejected.*, transition-terminal.*
// ---------------------------------------------------------------------------

describe('SpecialistTask state machine', () => {
  describe('valid transitions', () => {
    it.todo('queued -> running (via SpecialistTaskStarted)');
    it.todo('queued -> awaiting_restart (via SpecialistContainerCrashed while queued)');
    it.todo('queued -> failed (via SpecialistTaskTimedOut while queued)');
    it.todo('running -> awaiting_sub_task (via SpecialistDispatchesSubTask or MemoryProviderDispatched)');
    it.todo('running -> awaiting_restart (via SpecialistContainerCrashed while running)');
    it.todo('running -> completed (via SpecialistTaskCompleted)');
    it.todo('running -> failed (via SpecialistTaskFailed or SpecialistTaskTimedOut)');
    it.todo('awaiting_sub_task -> awaiting_restart (via SpecialistContainerCrashed while awaiting)');
    it.todo('awaiting_sub_task -> running (via SubTaskResultRouted — parent resumes)');
    it.todo('awaiting_sub_task -> failed (via SpecialistTaskTimedOut while awaiting)');
    it.todo('awaiting_restart -> running (via SpecialistTaskStarted after restart)');
    it.todo('awaiting_restart -> failed (via SpecialistRestartLimitExceeded)');
  });

  describe('rejected transitions — obligation id: transition-rejected.SpecialistTask.status', () => {
    it.todo('running -> queued is not a valid transition');
    it.todo('completed -> running is not a valid transition (terminal state)');
    it.todo('failed -> running is not a valid transition (terminal state)');
    it.todo('awaiting_sub_task -> queued is not a valid transition');
    it.todo('awaiting_restart -> completed is not a valid transition (must go through running)');
  });

  describe('terminal states — obligation id: transition-terminal.SpecialistTask.status', () => {
    it.todo('completed is terminal — no outbound transitions');
    it.todo('failed is terminal — no outbound transitions');
    it.todo('a completed task has closed_at set');
    it.todo('a failed task has closed_at set');
    it.todo('a failed task has failure set with kind and detail');
  });
});

// ---------------------------------------------------------------------------
// IpcOutMount state machine
// ---------------------------------------------------------------------------

describe('IpcOutMount state machine', () => {
  it.todo('active -> cleared is the only valid transition');
  it.todo('cleared -> active is rejected (terminal)');
  it.todo('cleared is terminal');
  it.todo('IpcOutMount is created in active state when an invocation starts');
  it.todo('IpcOutMount transitions to cleared when the invocation ends');
});

// ---------------------------------------------------------------------------
// IpcInMount state machine
// ---------------------------------------------------------------------------

describe('IpcInMount state machine', () => {
  it.todo('active -> cleared is the only valid transition');
  it.todo('cleared -> active is rejected (terminal)');
  it.todo('cleared is terminal');
  it.todo('IpcInMount is created in active state immediately before the container process starts');
  it.todo('IpcInMount is populated only with files staged for this specific invocation');
  it.todo('IpcInMount transitions to cleared when the invocation ends');
});

// ---------------------------------------------------------------------------
// ContainerTransfer state machine — obligation ids: transition-edge.ContainerTransfer.*
// ---------------------------------------------------------------------------

describe('ContainerTransfer state machine', () => {
  describe('valid transitions', () => {
    it.todo('pending -> in_transit (files placed into requester ipc-in, commit_to_memory=false)');
    it.todo('pending -> committed (files committed to memory, commit_to_memory=true)');
    it.todo('pending -> expired (empty transfer or all files lost before placement)');
    it.todo('in_transit -> expired (requester task reached terminal state)');
    it.todo('committed -> expired (staging copies reclaimed; memory copies persist)');
  });

  describe('terminal states', () => {
    it.todo('expired is the only terminal state');
    it.todo('no transitions out of expired');
  });

  describe('entity relationship — obligation id: entity-relationship.ContainerTransfer.files', () => {
    it.todo('ContainerTransfer.files returns the TransferFile rows where transfer = this');
    it.todo('ContainerTransfer.file_count matches the actual number of TransferFile rows');
  });
});

// ---------------------------------------------------------------------------
// TransferFile state machine
// ---------------------------------------------------------------------------

describe('TransferFile state machine', () => {
  describe('valid transitions', () => {
    it.todo('staged -> owned (host takes ownership from ipc-out)');
    it.todo('owned -> placed (file placed in recipient ipc-in)');
    it.todo('placed -> expired (recipient task is terminal)');
  });

  describe('terminal states', () => {
    it.todo('expired is the only terminal state');
    it.todo('no transitions out of expired');
  });

  describe('optional fields — obligation id: entity-optional.TransferFile.memory_path', () => {
    it.todo('memory_path is null when commit_to_memory=false');
    it.todo('memory_path is set to the workspace-relative final path when commit_to_memory=true');
    it.todo('memory_path persists after the transfer expires (memory copy survives cleanup)');
  });
});

// ---------------------------------------------------------------------------
// Rule: MainGroupDispatchesSpecialist
// obligation ids: rule-success.MainGroupDispatchesSpecialist,
//                 rule-failure.MainGroupDispatchesSpecialist.1-3,
//                 rule-entity-creation.MainGroupDispatchesSpecialist.1
// ---------------------------------------------------------------------------

describe('MainGroupDispatchesSpecialist rule', () => {
  it.todo('success: creates SpecialistTask with status=queued, depth=0, chain_delegation_count=1, ancestor_groups={}');
  it.todo('success: creates a per-task Session with messaging_group=null and thread_id=task.id');
  it.todo('success: writes a pending InboundMessage with kind="chat" and trigger=true into the task session');
  it.todo('success: emits SessionWoken for the task session');

  it.todo('failure[1]: requires session.agent_group.is_main = true — non-main group is rejected');
  it.todo('failure[2]: requires the target specialist_group_id to resolve to an existing AgentGroup');
  it.todo('failure[3]: requires the target AgentGroup to have a Specialist row');
});

// ---------------------------------------------------------------------------
// Rule: SpecialistTaskStarted
// obligation ids: rule-success.SpecialistTaskStarted,
//                 rule-failure.SpecialistTaskStarted.1
// ---------------------------------------------------------------------------

describe('SpecialistTaskStarted rule', () => {
  it.todo('success: transitions task from queued to running when container begins processing');
  it.todo('success: transitions task from awaiting_restart to running after a restart');
  it.todo('failure[1]: requires task.status in {queued, awaiting_restart} — running task is not re-transitioned');
});

// ---------------------------------------------------------------------------
// Rule: SpecialistDispatchesSubTask
// obligation ids: rule-success.SpecialistDispatchesSubTask,
//                 rule-failure.SpecialistDispatchesSubTask.1-11,
//                 rule-entity-creation.SpecialistDispatchesSubTask.1
// ---------------------------------------------------------------------------

describe('SpecialistDispatchesSubTask rule', () => {
  it.todo('success: creates child SpecialistTask with depth = parent.depth + 1');
  it.todo('success: child inherits ancestor_groups = parent.ancestor_groups + {parent.specialist_group}');
  it.todo('success: child chain_delegation_count = parent.chain_delegation_count + 1');
  it.todo('success: parent transitions to awaiting_sub_task');
  it.todo('success: parent.pending_sub_task = child');
  it.todo('success: child gets its own session and trigger InboundMessage');
  it.todo(
    'success: is_last_same_type_dispatch = true when this is the (max_same_type_dispatches - 1)th dispatch to this group',
  );
  it.todo('success: is_last_same_type_dispatch = false otherwise');

  it.todo('failure[1]: requires session.agent_group to have a Specialist row');
  it.todo('failure[2]: requires calling specialist is_memory_provider = false (memory providers cannot delegate)');
  it.todo('failure[3]: requires target AgentGroup exists');
  it.todo('failure[4]: requires target AgentGroup has a Specialist row');
  it.todo(
    'failure[5]: requires target specialist is_memory_provider = false (use MemoryProviderDispatched for memory providers)',
  );
  it.todo('failure[6]: requires a running_task_for_group exists for the calling session');
  it.todo('failure[7]: requires parent_task.status = running');
  it.todo('failure[8]: requires target_group not in parent_task.ancestor_groups (cycle check)');
  it.todo('failure[9]: requires parent_task.depth + 1 < max_specialist_depth');
  it.todo('failure[10]: requires parent_task.chain_delegation_count < max_chain_delegations');
  it.todo('failure[11]: requires same_type_dispatch_count < max_same_type_dispatches');
});

// ---------------------------------------------------------------------------
// Rule: SubTaskRejectedCycle
// obligation ids: rule-success.SubTaskRejectedCycle,
//                 rule-failure.SubTaskRejectedCycle.1-8,
//                 rule-entity-creation.SubTaskRejectedCycle.1
// ---------------------------------------------------------------------------

describe('SubTaskRejectedCycle rule', () => {
  it.todo('success: creates child SpecialistTask immediately in status=failed with kind=cycle_detected');
  it.todo('success: notifies the calling agent with "sub-task rejected: cycle detected"');
  it.todo('success: parent task is NOT moved to awaiting_sub_task (rejection is immediate)');

  it.todo('failure[1]: requires calling agent_group has Specialist row');
  it.todo('failure[2]: requires calling specialist is_memory_provider = false');
  it.todo('failure[3]: requires target AgentGroup exists');
  it.todo('failure[4]: requires target AgentGroup has Specialist row');
  it.todo('failure[5]: requires target specialist is_memory_provider = false');
  it.todo('failure[6]: requires parent_task exists and is running');
  it.todo('failure[7]: requires target_group IS in parent_task.ancestor_groups (the cycle condition)');
  it.todo('failure[8]: does not fire when no cycle — SpecialistDispatchesSubTask fires instead');
});

// ---------------------------------------------------------------------------
// Rule: SubTaskRejectedDepth
// obligation ids: rule-success.SubTaskRejectedDepth,
//                 rule-failure.SubTaskRejectedDepth.1-9,
//                 rule-entity-creation.SubTaskRejectedDepth.1
// ---------------------------------------------------------------------------

describe('SubTaskRejectedDepth rule', () => {
  it.todo('success: creates child immediately in status=failed with kind=depth_exceeded');
  it.todo('success: fires when parent.depth + 1 >= max_specialist_depth (default: at depth=5)');
  it.todo('success: fires at exactly the boundary depth (depth + 1 = max_specialist_depth)');

  it.todo('failure[1]: requires calling specialist exists and is not memory provider');
  it.todo('failure[2]: requires target specialist exists and is not memory provider');
  it.todo('failure[3]: requires parent_task exists and is running');
  it.todo('failure[4]: requires no cycle (target not in ancestor_groups)');
  it.todo('failure[5]: requires depth + 1 >= max_specialist_depth — does not fire within limit');
  it.todo('failure[6]: does not fire at depth + 1 = max_specialist_depth - 1 (within limit)');
  it.todo('failure[7]: does not fire when chain count is the binding constraint');
  it.todo('failure[8]: does not fire when same-type count is the binding constraint');
  it.todo('failure[9]: chain_delegation_count is still incremented on the rejected child');
});

// ---------------------------------------------------------------------------
// Rule: SubTaskRejectedCount
// obligation ids: rule-success.SubTaskRejectedCount,
//                 rule-failure.SubTaskRejectedCount.1-10,
//                 rule-entity-creation.SubTaskRejectedCount.1
// ---------------------------------------------------------------------------

describe('SubTaskRejectedCount rule', () => {
  it.todo('success: creates child immediately in status=failed with kind=count_exceeded');
  it.todo('success: fires when parent.chain_delegation_count >= max_chain_delegations (default: at 20)');
  it.todo('success: fires at exactly the boundary count');

  it.todo('failure[1]: requires calling specialist exists and is not memory provider');
  it.todo('failure[2]: requires target specialist exists and is not memory provider');
  it.todo('failure[3]: requires parent_task exists and is running');
  it.todo('failure[4]: requires no cycle');
  it.todo('failure[5]: requires depth within limit (depth + 1 < max_specialist_depth)');
  it.todo('failure[6]: requires chain_delegation_count >= max_chain_delegations');
  it.todo('failure[7]: does not fire when count is within limit');
  it.todo('failure[8]: does not fire when depth is the binding constraint');
  it.todo('failure[9]: does not fire when same-type count is the binding constraint');
  it.todo('failure[10]: child chain_delegation_count is set to parent count + 1 even on rejection');
});

// ---------------------------------------------------------------------------
// Rule: SubTaskRejectedSameTypeLimit
// obligation ids: rule-success.SubTaskRejectedSameTypeLimit,
//                 rule-failure.SubTaskRejectedSameTypeLimit.1-11,
//                 rule-entity-creation.SubTaskRejectedSameTypeLimit.1
// ---------------------------------------------------------------------------

describe('SubTaskRejectedSameTypeLimit rule', () => {
  it.todo('success: creates child immediately in status=failed with kind=same_type_limit_exceeded');
  it.todo('success: fires when same_type_dispatch_count >= max_same_type_dispatches (default: at 3)');
  it.todo('success: fires at exactly the boundary count');

  it.todo('failure[1]: requires calling specialist exists and is not memory provider');
  it.todo('failure[2]: requires target specialist exists and is not memory provider');
  it.todo('failure[3]: requires parent_task exists and is running');
  it.todo('failure[4]: requires no cycle');
  it.todo('failure[5]: requires depth within limit');
  it.todo('failure[6]: requires chain count within limit');
  it.todo('failure[7]: requires same_type_dispatch_count >= max_same_type_dispatches');
  it.todo('failure[8]: does not fire when same-type count is within limit');
  it.todo('failure[9]: memory-provider dispatches are not counted toward same_type_dispatch_count');
  it.todo('failure[10]: same_type_dispatch_count counts only dispatches to the exact same specialist_group');
  it.todo('failure[11]: dispatches to different specialist groups count separately');
});

// ---------------------------------------------------------------------------
// Rule: MemoryProviderDispatched
// obligation ids: rule-success.MemoryProviderDispatched,
//                 rule-failure.MemoryProviderDispatched.1-7,
//                 rule-entity-creation.MemoryProviderDispatched.1
// ---------------------------------------------------------------------------

describe('MemoryProviderDispatched rule', () => {
  it.todo('success: creates child task with depth = parent.depth (not incremented)');
  it.todo('success: creates child task with chain_delegation_count = parent.chain_delegation_count (not incremented)');
  it.todo('success: creates child task with ancestor_groups = parent.ancestor_groups (unchanged)');
  it.todo('success: creates child task with is_last_same_type_dispatch = false');
  it.todo('success: parent transitions to awaiting_sub_task');
  it.todo('success: child gets its own session and trigger InboundMessage');
  it.todo('success: bypasses cycle, depth, count, and same-type checks');

  it.todo('failure[1]: requires calling specialist exists and is not a memory provider');
  it.todo('failure[2]: requires target AgentGroup exists');
  it.todo('failure[3]: requires target specialist exists');
  it.todo(
    'failure[4]: requires target specialist IS a memory provider (non-memory providers go through SpecialistDispatchesSubTask)',
  );
  it.todo('failure[5]: requires parent_task exists');
  it.todo('failure[6]: requires parent_task.status = running');
  it.todo('failure[7]: does not fire for non-memory-provider targets');
});

// ---------------------------------------------------------------------------
// Remaining rule stubs (result routing, crash recovery, timeout, file handover)
// obligation ids: rule-success.SubTaskResultRouted, rule-success.RootTaskResultRouted,
//                 rule-success.SpecialistContainerCrashed, rule-success.SpecialistRestartLimitExceeded,
//                 rule-success.SpecialistTaskTimedOut, rule-success.SpecialistTaskCompleted,
//                 rule-success.SpecialistTaskFailed,
//                 rule-success.InvocationStarted, rule-success.InvocationEnded,
//                 rule-success.TransferOwnershipTaken, rule-success.TransferPlacedInIpcIn,
//                 rule-success.TransferCommittedToMemory, rule-success.TransferExpired
// ---------------------------------------------------------------------------

describe('SubTaskResultRouted rule', () => {
  it.todo('success: routes the child result back to the awaiting parent session');
  it.todo('success: parent transitions from awaiting_sub_task to running');
  it.todo('success: parent.pending_sub_task is cleared');
  it.todo('failure: requires parent_task.status = awaiting_sub_task');
  it.todo('failure: requires child task is in a terminal state (completed or failed)');
});

describe('RootTaskResultRouted rule', () => {
  it.todo('success: delivers the specialist result to the original main-group session');
  it.todo('success: result text is path-rewritten if files were staged');
  it.todo('failure: requires task.requester_group is not null (root task)');
  it.todo('failure: requires task.status = completed or failed');
});

describe('SpecialistContainerCrashed rule', () => {
  it.todo('success: transitions running task to awaiting_restart when restart_attempt_count < max_restart_retries');
  it.todo('success: increments restart_attempt_count');
  it.todo('success: transitions queued task to awaiting_restart (crash before first processing)');
  it.todo('success: transitions awaiting_sub_task task to awaiting_restart');
  it.todo('failure: requires task.status in {queued, running, awaiting_sub_task}');
});

describe('SpecialistRestartLimitExceeded rule', () => {
  it.todo(
    'success: transitions awaiting_restart -> failed with kind=host_restart when restart_attempt_count >= max_restart_retries',
  );
  it.todo('success: sets closed_at and failure on the task');
  it.todo('failure: requires task.status = awaiting_restart');
  it.todo('failure: requires restart_attempt_count >= max_restart_retries');
});

describe('SpecialistTaskTimedOut rule', () => {
  it.todo(
    'success: transitions any live task (queued/running/awaiting_sub_task/awaiting_restart) to failed with kind=timeout',
  );
  it.todo('success: sets closed_at and failure on the task');
  it.todo('success: fires when is_overdue = true');
  it.todo('failure: does not fire for terminal tasks');
  // Temporal test note: requires controllable clock injected into the timeout sweep.
  // Do not test by sleeping.
});

describe('InvocationStarted rule', () => {
  it.todo('success: creates IpcOutMount in active state for the new invocation');
  it.todo('success: creates IpcInMount in active state populated with staged files for this invocation');
  it.todo('success: each invocation gets a fresh, empty ipc-out and a populated ipc-in');
});

describe('InvocationEnded rule', () => {
  it.todo('success: transitions IpcOutMount from active to cleared');
  it.todo('success: transitions IpcInMount from active to cleared');
  it.todo('success: files not consumed by a delivery are discarded');
});

describe('TransferOwnershipTaken rule', () => {
  it.todo('success: creates ContainerTransfer with status=pending');
  it.todo('success: creates one TransferFile per file_path with status=staged -> owned');
  it.todo('success: host_path is set for each TransferFile after copy');
  it.todo('success: file_count matches the number of file_paths');
  it.todo('failure: requires the delivering invocation has an active IpcOutMount');
  it.todo('failure: requires file_paths are all present in ipc-out');
});

describe('TransferPlacedInIpcIn rule (commit_to_memory=false)', () => {
  it.todo('success: transitions ContainerTransfer pending -> in_transit');
  it.todo('success: transitions each TransferFile owned -> placed');
  it.todo('success: files are copied to the recipient invocation ipc-in before its container starts');
  it.todo('success: result text is rewritten to reference ipc-in paths');
  it.todo('failure: requires commit_to_memory = false');
  it.todo('failure: requires a living recipient invocation exists');
});

describe('TransferCommittedToMemory rule (commit_to_memory=true)', () => {
  it.todo('success: transitions ContainerTransfer pending -> committed');
  it.todo('success: copies files to requester_group.folder / memory_reports_subpath');
  it.todo('success: sets memory_path on each TransferFile');
  it.todo('success: sets committed_files on the parent SpecialistTask');
  it.todo('success: result text is rewritten to reference memory paths');
  it.todo('failure: requires commit_to_memory = true');
});

describe('TransferExpired rule', () => {
  it.todo('transitions ContainerTransfer in_transit -> expired when requester task reaches terminal state');
  it.todo('transitions ContainerTransfer committed -> expired (staging reclaimed; memory paths survive)');
  it.todo('transitions ContainerTransfer pending -> expired for empty transfers');
  it.todo('memory_path values on TransferFile rows are preserved after expiry');
});

// ---------------------------------------------------------------------------
// Scenario tests — cross-entity process obligations
// ---------------------------------------------------------------------------

describe('happy-path scenarios', () => {
  it.todo('root task: main group dispatches specialist -> runs -> completes -> result routed back');
  it.todo('sub-task chain: specialist dispatches sub-specialist -> both complete -> results flow back');
  it.todo('memory provider: specialist calls memory provider -> provider returns -> parent resumes');
  it.todo(
    'file handover (ipc-in): specialist delivers files with commit_to_memory=false -> files placed in requester ipc-in',
  );
  it.todo(
    'file handover (memory): specialist delivers files with commit_to_memory=true -> files committed to memory area',
  );
  it.todo('crash-and-restart: container crashes mid-task -> awaiting_restart -> restarts -> completes');
});

describe('chain-limit enforcement scenarios', () => {
  it.todo('depth limit: chain at depth=4 attempting depth=5 -> SubTaskRejectedDepth fires');
  it.todo('count limit: chain with 19 delegations attempting 20th -> SubTaskRejectedCount fires');
  it.todo('same-type limit: 2 prior dispatches to group X, 3rd dispatch to X -> SubTaskRejectedSameTypeLimit fires');
  it.todo('cycle detection: A -> B -> C -> A -> SubTaskRejectedCycle fires');
  it.todo('memory provider bypasses all chain limits');
});

describe('reachability: complete lifecycle paths', () => {
  it.todo('queued -> running -> completed (happy path)');
  it.todo('queued -> running -> failed (execution error)');
  it.todo('queued -> awaiting_restart -> running -> completed (restart path)');
  it.todo('queued -> awaiting_restart -> failed (restart limit exceeded)');
  it.todo('queued -> failed (immediate timeout before container starts)');
  it.todo('running -> awaiting_sub_task -> running -> completed (sub-task delegation)');
  it.todo('running -> awaiting_sub_task -> awaiting_restart -> running -> completed (crash while awaiting)');
  it.todo('ContainerTransfer: pending -> in_transit -> expired');
  it.todo('ContainerTransfer: pending -> committed -> expired');
  it.todo('TransferFile: staged -> owned -> placed -> expired');
});
