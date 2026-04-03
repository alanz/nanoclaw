/**
 * Tests propagated from docs/project/specs/specialists.allium
 *
 * Obligation categories covered:
 *   enum_comparable, value_equality, entity_fields, entity_optional,
 *   when_presence, entity_relationship, derived, invariant (entity + global),
 *   transition_edge, transition_rejected, transition_terminal,
 *   config_default, rule_success, rule_failure, rule_entity_creation, scenario
 *
 * Implementation required: src/specialists.ts (does not exist yet)
 * These tests are the TDD contract that the implementation must satisfy.
 *
 * When implementing, import from './specialists.js' and fill in each it.todo().
 * Deferred dependency: same_type_dispatch_count (→ delegation-policy.allium)
 * — rule tests for SpecialistDispatchesSubTask require it.
 */

import { describe, it } from 'vitest';

// TODO: uncomment and complete when src/specialists.ts is implemented
// import {
//   FailureKind, TaskFailure,
//   SpecialistType, SpecialistConversationSession, SpecialistTask,
//   RawMemorySubmission,
//   SPECIALISTS_CONFIG,
//   createSpecialistTask, dispatchSpecialist, dispatchSubTask,
//   startSpecialistContainer, reportSession, deliverResult,
//   submitRawMemory, acceptMemorySubmission,
//   handleNanoclawStarted,
// } from './specialists.js';
// import { _initTestDatabase } from './db.js';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

describe('FailureKind', () => {
  // enum-comparable.FailureKind
  it.todo(
    'all variants are present: cycle_detected, depth_exceeded, count_exceeded, same_type_limit_exceeded, timeout, execution_error, host_restart',
  );
  it.todo('variants are comparable by identity (same value === same value)');
  it.todo('distinct variants are not equal');
});

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

describe('TaskFailure', () => {
  // value-equality.TaskFailure
  it.todo(
    'two TaskFailure objects with same kind and detail are structurally equal',
  );
  it.todo('two TaskFailure objects with different kind are not equal');
  // entity-fields.TaskFailure
  it.todo('has kind field typed as FailureKind');
  it.todo('has detail field typed as String');
});

// ---------------------------------------------------------------------------
// SpecialistType entity
// ---------------------------------------------------------------------------

describe('SpecialistType', () => {
  // entity-fields.SpecialistType
  it.todo(
    'has name, description, is_memory_provider, last_turn_sub_notice, last_turn_parent_notice fields',
  );
  // entity-optional.SpecialistType.last_turn_sub_notice
  it.todo('last_turn_sub_notice accepts null (uses default notice when null)');
  it.todo('last_turn_sub_notice accepts a non-null string override');
  // entity-optional.SpecialistType.last_turn_parent_notice
  it.todo(
    'last_turn_parent_notice accepts null (uses default notice when null)',
  );
  it.todo('last_turn_parent_notice accepts a non-null string override');
});

// ---------------------------------------------------------------------------
// SpecialistConversationSession entity
// ---------------------------------------------------------------------------

describe('SpecialistConversationSession', () => {
  // entity-fields.SpecialistConversationSession
  it.todo('has task, session_id, status fields');

  describe('status transition graph', () => {
    // transition-edge.SpecialistConversationSession.*
    it.todo('active -> stale: session file missing on re-invocation');
    it.todo(
      'stale -> active: re-invocation succeeded; session restored (SpecialistSessionEstablished)',
    );
    it.todo('active -> cleared: task reached a terminal state');
    it.todo('stale -> cleared: task reached a terminal state');

    // transition-rejected.SpecialistConversationSession.status
    it.todo('cleared -> active is rejected (terminal state)');
    it.todo('cleared -> stale is rejected (terminal state)');
    it.todo('stale -> stale is rejected (no self-transitions declared)');

    // transition-terminal.SpecialistConversationSession.status
    it.todo('cleared has no outbound transitions');
  });
});

// ---------------------------------------------------------------------------
// SpecialistTask entity
// ---------------------------------------------------------------------------

describe('SpecialistTask', () => {
  // entity-fields.SpecialistTask
  it.todo(
    'has all declared fields: specialist_type, prompt, requester_group, requester_task, ' +
      'depth, chain_delegation_count, ancestor_types, delegated_at, closed_at, ' +
      'restart_attempt_count, status, is_last_same_type_dispatch, ' +
      'pending_sub_task, result, failure, conversation, is_overdue, has_cycle',
  );

  // entity-optional.*
  it.todo(
    'requester_group accepts null (when dispatched by a specialist) and non-null (when dispatched by main group)',
  );
  it.todo(
    'requester_task accepts null (when dispatched by main group) and non-null (when dispatched by specialist)',
  );
  it.todo(
    'closed_at is null while task is live, non-null after reaching a terminal state',
  );

  // entity-relationship.SpecialistTask.conversation
  it.todo(
    'conversation relationship navigates to the SpecialistConversationSession whose task field matches this task',
  );

  // when-presence.SpecialistTask.pending_sub_task
  it.todo('pending_sub_task is present when status = awaiting_sub_task');
  it.todo('pending_sub_task is absent when status = queued');
  it.todo('pending_sub_task is absent when status = running');
  it.todo('pending_sub_task is absent when status = awaiting_restart');
  it.todo('pending_sub_task is absent when status = completed');
  it.todo('pending_sub_task is absent when status = failed');

  // when-presence.SpecialistTask.result
  it.todo('result is present when status = completed');
  it.todo('result is absent when status = queued');
  it.todo('result is absent when status = running');
  it.todo('result is absent when status = awaiting_sub_task');
  it.todo('result is absent when status = awaiting_restart');
  it.todo('result is absent when status = failed');

  // when-presence.SpecialistTask.failure
  it.todo('failure is present when status = failed');
  it.todo('failure is absent when status = queued');
  it.todo('failure is absent when status = running');
  it.todo('failure is absent when status = awaiting_sub_task');
  it.todo('failure is absent when status = awaiting_restart');
  it.todo('failure is absent when status = completed');

  // invariant.SpecialistTask.ExactlyOneRequester
  it.todo(
    'ExactlyOneRequester: requester_group non-null and requester_task null is valid',
  );
  it.todo(
    'ExactlyOneRequester: requester_task non-null and requester_group null is valid',
  );
  it.todo('ExactlyOneRequester: both null is rejected');
  it.todo('ExactlyOneRequester: both non-null is rejected');

  // invariant.SpecialistTask.DepthMatchesAncestorCount
  it.todo(
    'DepthMatchesAncestorCount: depth equals ancestor_types.count at creation',
  );
  it.todo(
    'DepthMatchesAncestorCount: depth 0 with empty ancestor_types is valid',
  );
  it.todo(
    'DepthMatchesAncestorCount: depth 2 with two ancestor types is valid',
  );

  // derived.SpecialistTask.is_overdue
  it.todo(
    'is_overdue is false when status is live and duration is within max_task_duration',
  );
  it.todo(
    'is_overdue is true when status is live and now - delegated_at > max_task_duration',
  );
  it.todo('is_overdue is false for terminal tasks regardless of age');

  // derived has_cycle (inline)
  it.todo('has_cycle is false when specialist_type is not in ancestor_types');
  it.todo('has_cycle is true when specialist_type appears in ancestor_types');

  describe('status transition graph', () => {
    // transition-edge.SpecialistTask.*
    it.todo(
      'queued -> running: first container invocation started (SpecialistTaskStarted)',
    );
    it.todo('queued -> failed: policy rejection before dispatch');
    it.todo(
      'running -> awaiting_sub_task: specialist dispatched a sub-task (SpecialistDispatchesSubTask)',
    );
    it.todo(
      'running -> completed: specialist delivered result (SpecialistTaskCompleted)',
    );
    it.todo(
      'running -> awaiting_restart: host killed; retries remaining (SpecialistTaskScheduledForRetry)',
    );
    it.todo(
      'running -> failed: container crashed, timed out, or retries exhausted',
    );
    it.todo(
      'awaiting_sub_task -> running: sub-task completed; specialist re-invoked (SpecialistTaskResumed)',
    );
    it.todo(
      'awaiting_sub_task -> failed: overall task timeout while waiting for sub-task',
    );
    it.todo(
      'awaiting_restart -> running: retry container started (SpecialistTaskRetryStarted)',
    );
    it.todo('awaiting_restart -> failed: overall timeout or retries exhausted');

    // transition-rejected.SpecialistTask.status
    it.todo('completed -> running is rejected (terminal)');
    it.todo('failed -> running is rejected (terminal)');
    it.todo('queued -> awaiting_sub_task is rejected (undeclared)');
    it.todo(
      'awaiting_sub_task -> completed is rejected (undeclared — must go through running first)',
    );

    // transition-terminal.SpecialistTask.status
    it.todo('completed has no outbound transitions');
    it.todo('failed has no outbound transitions');
  });
});

// ---------------------------------------------------------------------------
// RawMemorySubmission entity
// ---------------------------------------------------------------------------

describe('RawMemorySubmission', () => {
  // entity-fields
  it.todo(
    'has task, topic, staging_path, submitted_at, accepted_at?, final_path (when accepted), status, is_staging_overdue fields',
  );

  // entity-optional
  it.todo('accepted_at is null before acceptance, non-null after');

  // when-presence.RawMemorySubmission.final_path
  it.todo('final_path is present when status = accepted');
  it.todo('final_path is absent when status = staged');

  // derived is_staging_overdue
  it.todo(
    'is_staging_overdue is false when staged and duration is within max_staging_duration',
  );
  it.todo(
    'is_staging_overdue is true when staged and now - submitted_at > max_staging_duration',
  );
  it.todo(
    'is_staging_overdue is false when status = accepted regardless of age',
  );

  describe('status transition graph', () => {
    it.todo(
      'staged -> accepted: MemorySubmissionAccepted sets final_path, accepted_at, emits RawMemoryFileReady',
    );
    it.todo('accepted has no outbound transitions (terminal)');
    it.todo('accepted -> staged is rejected');
  });
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe('SPECIALISTS_CONFIG defaults', () => {
  // config-default.*
  it.todo('max_specialist_depth defaults to 5');
  it.todo('max_chain_delegations defaults to 20');
  it.todo('max_same_type_dispatches defaults to 3');
  it.todo('max_task_duration defaults to 4 hours (14400 seconds)');
  it.todo('container_timeout defaults to 30 minutes (1800 seconds)');
  it.todo('max_restart_retries defaults to 2');
  it.todo('max_staging_duration defaults to 2 hours (7200 seconds)');
  it.todo(
    'default_last_turn_sub_notice is the canonical "Final iteration" string from the spec',
  );
  it.todo(
    'default_last_turn_parent_notice is the canonical "no further responses" string from the spec',
  );
});

// ---------------------------------------------------------------------------
// Rule: MainDispatchesSpecialistTask
// ---------------------------------------------------------------------------

describe('rule MainDispatchesSpecialistTask', () => {
  // rule-success
  it.todo(
    'creates SpecialistTask with status=queued, depth=0, chain_delegation_count=1, ancestor_types={}',
  );
  it.todo('sets requester_group to the dispatching group, requester_task=null');
  it.todo('sets delegated_at to now');

  // rule-failure (requires: main_group.is_main)
  it.todo('rejected when dispatching group is not the main group');

  // rule-entity-creation
  it.todo(
    'created task satisfies ExactlyOneRequester invariant (requester_group set, requester_task null)',
  );
  it.todo(
    'created task satisfies DepthMatchesAncestorCount (depth=0, ancestor_types empty)',
  );
});

// ---------------------------------------------------------------------------
// Rule: SpecialistDispatchesSubTask + rejection rules
// ---------------------------------------------------------------------------

describe('rule SpecialistDispatchesSubTask', () => {
  // rule-success
  it.todo(
    'creates sub-task with depth=parent.depth+1 and chain_delegation_count=parent.chain_delegation_count+1',
  );
  it.todo('adds parent.specialist_type to sub-task.ancestor_types');
  it.todo('transitions parent to awaiting_sub_task with pending_sub_task set');
  it.todo('saves session_id on parent.conversation before container exits');
  it.todo(
    'sets is_last_same_type_dispatch=true when at the last permitted dispatch (max_same_type_dispatches - 1)',
  );
  it.todo('sets is_last_same_type_dispatch=false for earlier dispatches');

  // rule-failure (requires: parent_task.status = running)
  it.todo('rejected when parent task is not running');

  // rule-failure (requires: not is_memory_provider)
  it.todo('rejected when parent specialist type is a memory provider');

  // rule-failure (requires: target_type not in ancestor_types) → SubTaskRejectedCycle
  it.todo(
    'SubTaskRejectedCycle: creates failed sub-task with kind=cycle_detected when target already in ancestor chain',
  );
  it.todo(
    'SubTaskRejectedCycle: parent task remains running (no awaiting_sub_task transition)',
  );

  // rule-failure (requires: depth+1 < max_specialist_depth) → SubTaskRejectedDepth
  it.todo(
    'SubTaskRejectedDepth: creates failed sub-task with kind=depth_exceeded when at max depth',
  );
  it.todo(
    'SubTaskRejectedDepth: still succeeds at depth max_specialist_depth - 1',
  );

  // rule-failure (requires: chain_delegation_count < max_chain_delegations) → SubTaskRejectedCount
  it.todo(
    'SubTaskRejectedCount: creates failed sub-task with kind=count_exceeded when chain is at max delegations',
  );

  // rule-failure (requires: same_type_dispatch_count < max_same_type_dispatches) → SubTaskRejectedSameTypeLimit
  // NOTE: requires same_type_dispatch_count from deferred delegation-policy.allium
  it.todo(
    '[deferred: same_type_dispatch_count] SubTaskRejectedSameTypeLimit: creates failed sub-task with kind=same_type_limit_exceeded when per-type limit is reached',
  );
  it.todo(
    '[deferred: same_type_dispatch_count] SubTaskRejectedSameTypeLimit: the last valid dispatch (is_last flag=true) is still accepted',
  );
});

// ---------------------------------------------------------------------------
// Rule: SpecialistQueriesMemory
// ---------------------------------------------------------------------------

describe('rule SpecialistQueriesMemory', () => {
  // rule-success
  it.todo(
    'dispatches memory task when target is a memory provider (is_memory_provider=true)',
  );
  it.todo(
    'memory task is exempt from cycle detection (target in ancestor_types does not reject)',
  );
  it.todo(
    'memory task is exempt from depth enforcement (depth+1 >= max_specialist_depth does not reject)',
  );
  it.todo('transitions querying task to awaiting_sub_task');
  it.todo('saves session_id on querying task conversation');
});

// ---------------------------------------------------------------------------
// Rules: Container lifecycle
// ---------------------------------------------------------------------------

describe('rule SpecialistTaskStarted', () => {
  it.todo(
    'transitions queued -> running when SpecialistContainerStarted fires',
  );
  it.todo('no session_id is passed to the container on first invocation');
  it.todo(
    'prepends last_turn_sub_notice when is_last_same_type_dispatch=true, using type override if set',
  );
  it.todo('uses default_last_turn_sub_notice when type override is null');
});

describe('rule SpecialistTaskResumed', () => {
  it.todo(
    'transitions awaiting_sub_task -> running when SpecialistContainerStarted fires',
  );
  it.todo('clears pending_sub_task on transition');
  it.todo(
    'passes saved session_id to container so specialist resumes conversation',
  );
});

describe('rule SpecialistTaskRetryStarted', () => {
  it.todo(
    'transitions awaiting_restart -> running when retry container starts',
  );
  it.todo('passes stale conversation session_id to container');
});

describe('rule SpecialistSessionEstablished', () => {
  it.todo(
    'creates SpecialistConversationSession with status=active on first session report',
  );
  it.todo(
    'updates session_id and sets status=active on subsequent reports (resumes existing session)',
  );
  it.todo('only fires while task status = running');
});

// ---------------------------------------------------------------------------
// Rules: Result delivery
// ---------------------------------------------------------------------------

describe('rule SpecialistTaskCompleted', () => {
  // rule-success
  it.todo('stores result text on task, transitions to completed');
  it.todo('sets closed_at');
  it.todo('sets conversation.status = cleared');
  it.todo('emits SpecialistResultDelivered targeting requester_group when set');
  it.todo('emits SpecialistResultDelivered targeting requester_task when set');

  // rule-failure
  it.todo('rejected when task.status != running');
});

describe('rule ParentSpecialistResumed', () => {
  it.todo(
    'emits SpecialistContainerRestarted for the parent task when sub-task completes',
  );
  it.todo('injects sub-task result as tool response into resumed conversation');
  it.todo(
    'appends last_turn_parent_notice to injected result when is_last_same_type_dispatch=true',
  );
  it.todo(
    'only fires when requester_task is set (not for main-group-initiated tasks)',
  );
});

// ---------------------------------------------------------------------------
// Rules: Failure
// ---------------------------------------------------------------------------

describe('rule SpecialistInvocationTimedOut', () => {
  it.todo(
    'transitions running -> failed with kind=timeout on per-invocation timeout',
  );
  it.todo('sets closed_at and clears conversation session');
  it.todo('propagates failure to requester via SpecialistResultDelivered');
});

describe('rule SpecialistTaskOverallTimeout (is_overdue)', () => {
  it.todo('transitions queued -> failed when overall task duration exceeded');
  it.todo('transitions running -> failed when overall task duration exceeded');
  it.todo(
    'transitions awaiting_sub_task -> failed when overall task duration exceeded',
  );
  it.todo('does not fire for terminal tasks (completed, failed)');
  it.todo(
    'failure kind is timeout with detail "Overall task duration exceeded"',
  );
});

describe('rule SpecialistTaskCrashed', () => {
  it.todo(
    'transitions running -> failed with kind=execution_error on unexpected container exit',
  );
  it.todo('sets closed_at and clears conversation session');
  it.todo('propagates failure to requester');
});

// ---------------------------------------------------------------------------
// Rules: Host restart recovery
// ---------------------------------------------------------------------------

describe('host restart recovery (NanoclawStarted)', () => {
  describe('rule SpecialistTaskScheduledForRetry', () => {
    it.todo(
      'running task with restart_attempt_count < max_restart_retries -> awaiting_restart, increments restart_attempt_count',
    );
    it.todo('marks conversation session as stale');
    it.todo(
      'emits SpecialistContainerRestarted with inject=null (cold restart)',
    );
  });

  describe('rule SpecialistTaskFailedAfterRetriesExhausted', () => {
    it.todo(
      'running task with restart_attempt_count >= max_restart_retries -> failed with kind=host_restart',
    );
    it.todo('sets closed_at and clears conversation session');
    it.todo('propagates failure to requester');
  });

  describe('rule SpecialistTaskSubResultAvailableAfterRestart', () => {
    it.todo(
      'awaiting_sub_task with completed sub-task fires SpecialistContainerRestarted with the sub-task',
    );
    it.todo(
      'awaiting_sub_task with failed sub-task fires SpecialistContainerRestarted with the failure',
    );
  });

  describe('rule StartupRecoveryReported', () => {
    it.todo(
      'posts a single consolidated summary to main group chat when tasks need recovery',
    );
    it.todo('does not post when no tasks are in running state at startup');
    it.todo('records the summary to the host log at warning level');
  });

  describe('rule RestartRetryLogged', () => {
    it.todo(
      'records a warning log entry each time a task transitions to awaiting_restart',
    );
    it.todo('does NOT post to main group chat (silent retry)');
  });

  describe('rule RestartExhaustionReported', () => {
    it.todo(
      'posts failure message to main group chat when host_restart retries exhausted',
    );
    it.todo('records the message to the host log at error level');
  });
});

// ---------------------------------------------------------------------------
// Rules: Memory write path
// ---------------------------------------------------------------------------

describe('rule SpecialistSubmitsRawMemory', () => {
  it.todo('creates RawMemorySubmission in staged state with submitted_at=now');
  it.todo('posts memory_submission_notice to main group chat');
  it.todo(
    'is synchronous: task status remains running (specialist does not exit)',
  );
  it.todo('allows multiple submissions from a single running task');
  it.todo('rejected when task.status != running');
  it.todo('rejected when no main group is registered');
});

describe('rule MemorySubmissionAccepted', () => {
  it.todo('transitions staged -> accepted');
  it.todo('sets final_path and accepted_at');
  it.todo('emits RawMemoryFileReady for the embedding layer');
  it.todo('rejected when submission.status != staged');
});

describe('rule StagedSubmissionsRenotifiedOnRestart', () => {
  it.todo(
    're-sends memory_submission_notice for each staged submission at startup',
  );
  it.todo('does not re-notify submissions whose status is already accepted');
  it.todo('records a warning log for each re-notification');
});

describe('rule StagedSubmissionOverdue', () => {
  it.todo(
    'posts staging_overdue_alert to main group and logs warning when is_staging_overdue',
  );
  it.todo('does not re-fire once submission is accepted (status != staged)');
});

// ---------------------------------------------------------------------------
// Global invariants
// ---------------------------------------------------------------------------

describe('global invariants', () => {
  it.todo(
    'UniqueSpecialistNames: no two SpecialistType records share the same name',
  );
  it.todo('NoCycleInLiveTask: no live task has has_cycle=true');
  it.todo(
    'MemoryProviderDoesNotDelegate: memory providers cannot appear as requester_task of other tasks',
  );
  it.todo(
    'TaskDepthBounded: task.depth < config.max_specialist_depth for all tasks',
  );
  it.todo(
    'ClosedAtPresentWhenTerminal: closed_at non-null for completed/failed, null for live states',
  );
  it.todo(
    'OneConversationPerTask: at most one SpecialistConversationSession per task',
  );
  it.todo(
    'NoConversationForUninvokedTask: queued tasks have no conversation session',
  );
  it.todo(
    'RestartCountPositiveWhenAwaiting: restart_attempt_count > 0 in awaiting_restart',
  );
  it.todo('RunningTaskIsLeaf: no running task has a running child task');
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('scenario: happy path — main group dispatches specialist, receives result', () => {
  it.todo(
    'main group dispatches task -> queued; container starts -> running; result delivered -> completed; result injected into main group session',
  );
});

describe('scenario: two-level delegation (coder -> reviewer)', () => {
  it.todo(
    'coder task dispatches to reviewer; coder -> awaiting_sub_task; reviewer runs and completes; coder resumed with result; coder completes; main group receives final result',
  );
});

describe('scenario: producer-critic loop at max_same_type_dispatches', () => {
  it.todo(
    'the Nth dispatch is flagged is_last_same_type_dispatch=true and proceeds',
  );
  it.todo(
    'a further (N+1) dispatch attempt creates a failed sub-task with kind=same_type_limit_exceeded',
  );
  it.todo('both sides receive last-turn notices at the Nth boundary');
});

describe('scenario: host restart mid-task with retries', () => {
  it.todo(
    'running task retried silently up to max_restart_retries times; requester is not notified during retries',
  );
  it.todo('on final retry success, result delivered normally to requester');
  it.todo(
    'on retries exhausted, failure with kind=host_restart propagated to requester',
  );
});

describe('scenario: memory query from specialist', () => {
  it.todo(
    'specialist dispatches memory query; memory provider runs without cycle/depth checks; result injected back; specialist resumes',
  );
  it.todo('memory provider cannot dispatch further sub-tasks during its run');
});

describe('scenario: raw memory submission + acceptance', () => {
  it.todo(
    'specialist submits memory while running; main group receives notice; reviews and files at final_path; embedding layer notified',
  );
  it.todo('submission staged at restart is re-notified to main group');
});
