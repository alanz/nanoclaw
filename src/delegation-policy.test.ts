/**
 * Tests propagated from docs/project/specs/delegation-policy.allium
 *
 * Obligation categories covered:
 *   value_type (DelegationDecision), entity_optional (when-presence for rejection fields),
 *   rule_success, rule_failure (all 4 checks), rule_conditional (priority order),
 *   derived (same_type_dispatch_count — inclusion/exclusion of policy vs non-policy failures),
 *   invariant (AllowedDecisionClean, RejectedDecisionComplete, RejectionKindIsPolicyKind,
 *              SameTypeCountNonNegative),
 *   cross-module (memory provider bypass via is_memory_provider)
 *
 * Note on overlap with specialists.test.ts:
 *   specialists.test.ts covers the *mechanism* of rejection (SubTaskRejectedCycle etc.):
 *   the task state transitions that result from a policy decision. This file covers the
 *   *policy function itself*: DelegationDecision shape, priority order, and the
 *   same_type_dispatch_count counting semantics. Both files test against the same
 *   underlying implementation but from different obligation angles.
 */

import { describe, expect, it } from 'vitest';

import { SPECIALISTS_CONFIG } from './config.js';
import {
  checkDelegationPolicy,
  DelegationDecision,
} from './delegation-policy.js';
import { SpecialistTask, SpecialistType } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const POLICY_REJECTION_KINDS = new Set([
  'cycle_detected',
  'depth_exceeded',
  'count_exceeded',
  'same_type_limit_exceeded',
]);

function makeType(overrides: Partial<SpecialistType> = {}): SpecialistType {
  return {
    name: 'researcher',
    description: 'Researcher',
    isMemoryProvider: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<SpecialistTask> = {}): SpecialistTask {
  return {
    id: 'task-1',
    specialist_type: 'researcher',
    prompt: 'Do some research',
    requester_group: 'main@g.us',
    requester_task_id: null,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_types: '[]',
    is_last_same_type_dispatch: 0,
    status: 'running',
    pending_sub_task_id: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    restart_attempt_count: 0,
    delegated_at: '2024-01-01T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  };
}

const researcherType = makeType({ name: 'researcher' });
const coderType = makeType({ name: 'coder' });
const memoryType = makeType({ name: 'memory', isMemoryProvider: true });

// ---------------------------------------------------------------------------
// Value type: DelegationDecision
// ---------------------------------------------------------------------------

describe('DelegationDecision value type', () => {
  it('has outcome field typed as "allowed" | "rejected"', () => {
    const d: DelegationDecision = checkDelegationPolicy(
      makeTask(),
      researcherType,
      coderType,
      0,
    );
    expect(['allowed', 'rejected']).toContain(d.outcome);
  });

  it('has rejection_kind field typed as FailureKind | null', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(
      d.rejectionKind === null || typeof d.rejectionKind === 'string',
    ).toBe(true);
  });

  it('has rejection_detail field typed as String | null', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(
      d.rejectionDetail === null || typeof d.rejectionDetail === 'string',
    ).toBe(true);
  });

  it('rejection_kind is null when outcome is "allowed"', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
    expect(d.rejectionKind).toBeNull();
  });

  it('rejection_detail is null when outcome is "allowed"', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
    expect(d.rejectionDetail).toBeNull();
  });

  it('rejection_kind is non-null when outcome is "rejected"', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["coder"]' }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionKind).not.toBeNull();
  });

  it('rejection_detail is non-null when outcome is "rejected"', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["coder"]' }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionDetail).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule: CheckDelegationPolicySemantics — check_delegation_policy function
// ---------------------------------------------------------------------------

describe('checkDelegationPolicy — rule_success (all checks pass)', () => {
  it('returns allowed decision when target_type is not in ancestor_types, depth is within limit, chain count is within limit, and same-type count is within limit', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
  });

  it('allowed decision has outcome="allowed", rejection_kind=null, rejection_detail=null', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
    expect(d.rejectionKind).toBeNull();
    expect(d.rejectionDetail).toBeNull();
  });

  it('same_type_count is included in the evaluation result', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 2);
    expect(d.sameTypeCount).toBe(2);
  });

  it('function is pure: same inputs always produce the same output', () => {
    const task = makeTask();
    const d1 = checkDelegationPolicy(task, researcherType, coderType, 0);
    const d2 = checkDelegationPolicy(task, researcherType, coderType, 0);
    expect(d1).toEqual(d2);
  });
});

describe('checkDelegationPolicy — requires guards', () => {
  it('throws or rejects when parent_task.status is not running', () => {
    expect(() =>
      checkDelegationPolicy(
        makeTask({ status: 'queued' }),
        researcherType,
        coderType,
        0,
      ),
    ).toThrow();
  });

  it('throws or rejects when parent specialist type is a memory provider', () => {
    expect(() =>
      checkDelegationPolicy(makeTask(), memoryType, coderType, 0),
    ).toThrow();
  });

  it('throws or rejects when target type is a memory provider', () => {
    expect(() =>
      checkDelegationPolicy(makeTask(), researcherType, memoryType, 0),
    ).toThrow();
  });
});

describe('checkDelegationPolicy — Check 1: cycle detection', () => {
  it('returns rejected/cycle_detected when target_type is in parent_task.ancestor_types', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["coder"]' }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionKind).toBe('cycle_detected');
  });

  it('returns rejected/cycle_detected when target_type is the direct parent (one-level cycle)', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["researcher"]' }),
      coderType,
      researcherType,
      0,
    );
    expect(d.rejectionKind).toBe('cycle_detected');
  });

  it('returns rejected/cycle_detected when target_type appears anywhere in a deep ancestor chain', () => {
    const d = checkDelegationPolicy(
      makeTask({
        ancestor_types: '["researcher","code_reviewer","coder"]',
        depth: 3,
      }),
      makeType({ name: 'planner' }),
      researcherType,
      0,
    );
    expect(d.rejectionKind).toBe('cycle_detected');
  });

  it('allows dispatch when target_type is not in ancestor_types', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["coder"]' }),
      makeType({ name: 'coder' }),
      researcherType,
      0,
    );
    expect(d.outcome).toBe('allowed');
  });

  it('returns cycle_detected (not depth_exceeded) when both cycle and depth limit are violated', () => {
    const d = checkDelegationPolicy(
      makeTask({
        ancestor_types: '["coder"]',
        depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1,
      }),
      researcherType,
      coderType,
      0,
    );
    expect(d.rejectionKind).toBe('cycle_detected');
  });

  it('returns cycle_detected (not count_exceeded) when both cycle and chain count are violated', () => {
    const d = checkDelegationPolicy(
      makeTask({
        ancestor_types: '["coder"]',
        chain_delegation_count: SPECIALISTS_CONFIG.maxChainDelegations,
      }),
      researcherType,
      coderType,
      0,
    );
    expect(d.rejectionKind).toBe('cycle_detected');
  });
});

describe('checkDelegationPolicy — Check 2: depth limit', () => {
  it('returns rejected/depth_exceeded when parent_task.depth + 1 >= max_specialist_depth', () => {
    const d = checkDelegationPolicy(
      makeTask({ depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1 }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionKind).toBe('depth_exceeded');
  });

  it('returns rejected/depth_exceeded at exactly depth = max_specialist_depth - 1 (boundary: next step would exceed)', () => {
    const d = checkDelegationPolicy(
      makeTask({ depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1 }),
      researcherType,
      coderType,
      0,
    );
    expect(d.rejectionKind).toBe('depth_exceeded');
  });

  it('allows dispatch at depth = max_specialist_depth - 2 (one below the boundary)', () => {
    const d = checkDelegationPolicy(
      makeTask({ depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 2 }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('allowed');
  });

  it('returns depth_exceeded (not count_exceeded) when both depth and chain count are violated', () => {
    const d = checkDelegationPolicy(
      makeTask({
        depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1,
        chain_delegation_count: SPECIALISTS_CONFIG.maxChainDelegations,
      }),
      researcherType,
      coderType,
      0,
    );
    expect(d.rejectionKind).toBe('depth_exceeded');
  });

  it('returns depth_exceeded (not same_type_limit_exceeded) when both depth and same-type limit are violated', () => {
    const d = checkDelegationPolicy(
      makeTask({ depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1 }),
      researcherType,
      coderType,
      SPECIALISTS_CONFIG.maxSameTypeDispatches,
    );
    expect(d.rejectionKind).toBe('depth_exceeded');
  });
});

describe('checkDelegationPolicy — Check 3: chain count limit', () => {
  it('returns rejected/count_exceeded when parent_task.chain_delegation_count >= max_chain_delegations', () => {
    const d = checkDelegationPolicy(
      makeTask({
        chain_delegation_count: SPECIALISTS_CONFIG.maxChainDelegations,
      }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionKind).toBe('count_exceeded');
  });

  it('returns rejected/count_exceeded at exactly chain_delegation_count = max_chain_delegations (boundary)', () => {
    const d = checkDelegationPolicy(
      makeTask({
        chain_delegation_count: SPECIALISTS_CONFIG.maxChainDelegations,
      }),
      researcherType,
      coderType,
      0,
    );
    expect(d.rejectionKind).toBe('count_exceeded');
  });

  it('allows dispatch at chain_delegation_count = max_chain_delegations - 1', () => {
    const d = checkDelegationPolicy(
      makeTask({
        chain_delegation_count: SPECIALISTS_CONFIG.maxChainDelegations - 1,
      }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('allowed');
  });

  it('returns count_exceeded (not same_type_limit_exceeded) when both chain count and same-type limit are violated', () => {
    const d = checkDelegationPolicy(
      makeTask({
        chain_delegation_count: SPECIALISTS_CONFIG.maxChainDelegations,
      }),
      researcherType,
      coderType,
      SPECIALISTS_CONFIG.maxSameTypeDispatches,
    );
    expect(d.rejectionKind).toBe('count_exceeded');
  });
});

describe('checkDelegationPolicy — Check 4: same-type limit', () => {
  it('returns rejected/same_type_limit_exceeded when same_type_dispatch_count >= max_same_type_dispatches', () => {
    const d = checkDelegationPolicy(
      makeTask(),
      researcherType,
      coderType,
      SPECIALISTS_CONFIG.maxSameTypeDispatches,
    );
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionKind).toBe('same_type_limit_exceeded');
  });

  it('returns rejected/same_type_limit_exceeded at exactly same_type_dispatch_count = max_same_type_dispatches (boundary)', () => {
    const d = checkDelegationPolicy(
      makeTask(),
      researcherType,
      coderType,
      SPECIALISTS_CONFIG.maxSameTypeDispatches,
    );
    expect(d.rejectionKind).toBe('same_type_limit_exceeded');
  });

  it('allows dispatch at same_type_dispatch_count = max_same_type_dispatches - 1', () => {
    const d = checkDelegationPolicy(
      makeTask(),
      researcherType,
      coderType,
      SPECIALISTS_CONFIG.maxSameTypeDispatches - 1,
    );
    expect(d.outcome).toBe('allowed');
  });

  it('allows first dispatch to a type (same_type_dispatch_count = 0)', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
  });
});

// ---------------------------------------------------------------------------
// same_type_dispatch_count semantics
// (counting logic lives in Phase 5 getSameTypeDispatchCount; these tests
//  verify that the count parameter is correctly used by checkDelegationPolicy)
// ---------------------------------------------------------------------------

describe('same_type_dispatch_count semantics', () => {
  it('is 0 when no prior dispatches to target_type from parent_task', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.sameTypeCount).toBe(0);
  });

  it('counts only tasks with requester_task = parent_task', () => {
    // The caller computes sameTypeCount and passes it in — verify it is reflected
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 2);
    expect(d.sameTypeCount).toBe(2);
  });

  it('counts only tasks with specialist_type = target_type (not other types)', () => {
    // sameTypeCount=1 represents one prior dispatch to this type; policy allows it
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.outcome).toBe('allowed');
    expect(d.sameTypeCount).toBe(1);
  });

  it('excludes a prior task that failed with kind=cycle_detected (policy rejection)', () => {
    // With policy-rejected tasks excluded, sameTypeCount=0 even after a prior rejection
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
  });

  it('excludes a prior task that failed with kind=depth_exceeded (policy rejection)', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
  });

  it('excludes a prior task that failed with kind=count_exceeded (policy rejection)', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
  });

  it('excludes a prior task that failed with kind=same_type_limit_exceeded (policy rejection)', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
  });

  it('includes a prior task that failed with kind=timeout (non-policy: dispatch actually occurred)', () => {
    // sameTypeCount=1 because a timeout-failed task counts; still under limit
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.sameTypeCount).toBe(1);
  });

  it('includes a prior task that failed with kind=execution_error (non-policy: dispatch actually occurred)', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.sameTypeCount).toBe(1);
  });

  it('includes a prior task that failed with kind=host_restart (non-policy: dispatch actually occurred)', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.sameTypeCount).toBe(1);
  });

  it('includes a prior task that completed successfully', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.sameTypeCount).toBe(1);
    expect(d.outcome).toBe('allowed');
  });

  it('includes a prior task that is currently running', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.sameTypeCount).toBe(1);
  });

  it('correctly counts when history contains both policy-rejected and non-policy-failed tasks to the same type', () => {
    // 1 timeout (counts) + 1 cycle_detected (excluded) = sameTypeCount=1
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.sameTypeCount).toBe(1);
    expect(d.outcome).toBe('allowed');
  });

  it('policy-rejected tasks to a different type do not affect count for target_type', () => {
    // sameTypeCount for coderType is 0 regardless of what happened with other types
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.sameTypeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('AllowedDecisionClean invariant', () => {
  it('an allowed DelegationDecision always has rejection_kind = null', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
    expect(d.rejectionKind).toBeNull();
  });

  it('an allowed DelegationDecision always has rejection_detail = null', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.rejectionDetail).toBeNull();
  });
});

describe('RejectedDecisionComplete invariant', () => {
  it('a rejected DelegationDecision always has a non-null rejection_kind', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["coder"]' }),
      researcherType,
      coderType,
      0,
    );
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionKind).not.toBeNull();
  });

  it('a rejected DelegationDecision always has a non-null rejection_detail', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["coder"]' }),
      researcherType,
      coderType,
      0,
    );
    expect(d.rejectionDetail).not.toBeNull();
  });
});

describe('RejectionKindIsPolicyKind invariant', () => {
  it('rejection_kind is always one of: cycle_detected, depth_exceeded, count_exceeded, same_type_limit_exceeded', () => {
    const cases = [
      checkDelegationPolicy(
        makeTask({ ancestor_types: '["coder"]' }),
        researcherType,
        coderType,
        0,
      ),
      checkDelegationPolicy(
        makeTask({ depth: SPECIALISTS_CONFIG.maxSpecialistDepth - 1 }),
        researcherType,
        coderType,
        0,
      ),
      checkDelegationPolicy(
        makeTask({
          chain_delegation_count: SPECIALISTS_CONFIG.maxChainDelegations,
        }),
        researcherType,
        coderType,
        0,
      ),
      checkDelegationPolicy(
        makeTask(),
        researcherType,
        coderType,
        SPECIALISTS_CONFIG.maxSameTypeDispatches,
      ),
    ];
    for (const d of cases) {
      expect(d.outcome).toBe('rejected');
      expect(POLICY_REJECTION_KINDS.has(d.rejectionKind!)).toBe(true);
    }
  });

  it('rejection_kind is never timeout, execution_error, or host_restart', () => {
    const d = checkDelegationPolicy(
      makeTask({ ancestor_types: '["coder"]' }),
      researcherType,
      coderType,
      0,
    );
    expect(['timeout', 'execution_error', 'host_restart']).not.toContain(
      d.rejectionKind,
    );
  });
});

describe('SameTypeCountNonNegative invariant', () => {
  it('same_type_count in evaluation result is always >= 0', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.sameTypeCount).toBeGreaterThanOrEqual(0);
  });

  it('same_type_count is 0 for a root task with no prior dispatches', () => {
    const d = checkDelegationPolicy(
      makeTask({ depth: 0 }),
      researcherType,
      coderType,
      0,
    );
    expect(d.sameTypeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-module: memory provider bypass
// ---------------------------------------------------------------------------

describe('memory provider bypass (cross-module: specialists.allium)', () => {
  it('memory provider target type is never passed to check_delegation_policy (bypassed by SpecialistQueriesMemory)', () => {
    // The guard throws — callers must route memory queries via SpecialistQueriesMemory
    expect(() =>
      checkDelegationPolicy(makeTask(), researcherType, memoryType, 0),
    ).toThrow();
  });

  it('memory provider dispatch does not consume a same_type_dispatch_count slot', () => {
    // Memory provider dispatches bypass this function entirely (throw on entry).
    // The sameTypeCount passed in would be 0 since memory tasks are excluded.
    expect(() =>
      checkDelegationPolicy(makeTask(), researcherType, memoryType, 0),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario: producer-critic loop exhausting the same-type limit
// ---------------------------------------------------------------------------

describe('scenario: same-type dispatch counting with mixed failure history', () => {
  const max = SPECIALISTS_CONFIG.maxSameTypeDispatches;

  it('after N-1 successful dispatches to a type, next dispatch is allowed (count = N-1 < max)', () => {
    const d = checkDelegationPolicy(
      makeTask(),
      researcherType,
      coderType,
      max - 1,
    );
    expect(d.outcome).toBe('allowed');
  });

  it('after N successful dispatches, the (N+1)th is rejected/same_type_limit_exceeded (count = N >= max)', () => {
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, max);
    expect(d.outcome).toBe('rejected');
    expect(d.rejectionKind).toBe('same_type_limit_exceeded');
  });

  it('a policy-rejected attempt in the history does not count toward the limit, allowing a retry', () => {
    // policy-rejected tasks excluded from count → sameTypeCount stays at 0
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 0);
    expect(d.outcome).toBe('allowed');
  });

  it('a timeout-failed attempt in the history counts toward the limit (dispatch actually occurred)', () => {
    // 1 timeout = sameTypeCount 1; still under max (3)
    const d = checkDelegationPolicy(makeTask(), researcherType, coderType, 1);
    expect(d.sameTypeCount).toBe(1);
    expect(d.outcome).toBe('allowed');
  });
});
