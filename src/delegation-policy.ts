import { SPECIALISTS_CONFIG } from './config.js';
import { FailureKind, SpecialistTask, SpecialistType } from './types.js';

// ---------------------------------------------------------------------------
// Value type
// ---------------------------------------------------------------------------

export interface DelegationDecision {
  outcome: 'allowed' | 'rejected';
  rejectionKind: FailureKind | null;
  rejectionDetail: string | null;
  sameTypeCount: number;
}

// ---------------------------------------------------------------------------
// Policy function
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a proposed specialist-to-specialist dispatch is permitted.
 *
 * Pure and synchronous — the caller is responsible for supplying sameTypeCount
 * (computed from DB) so this function remains testable without a DB.
 *
 * Checks run in strict priority order (delegation-policy.allium):
 *   1. Cycle detection
 *   2. Depth limit
 *   3. Chain count limit
 *   4. Same-type dispatch limit
 *
 * @throws if parentTask.status !== 'running', or if either type is a memory provider
 *         (memory provider dispatches bypass this policy via SpecialistQueriesMemory)
 */
export function checkDelegationPolicy(
  parentTask: SpecialistTask,
  parentType: SpecialistType,
  targetType: SpecialistType,
  sameTypeCount: number,
): DelegationDecision {
  if (parentTask.status !== 'running') {
    throw new Error(
      `checkDelegationPolicy requires parent task to be running, got: ${parentTask.status}`,
    );
  }
  if (parentType.isMemoryProvider) {
    throw new Error(
      `checkDelegationPolicy: parent type "${parentType.name}" is a memory provider and cannot dispatch sub-tasks`,
    );
  }
  if (targetType.isMemoryProvider) {
    throw new Error(
      `checkDelegationPolicy: target type "${targetType.name}" is a memory provider — use SpecialistQueriesMemory instead`,
    );
  }

  const ancestorTypes: string[] = JSON.parse(parentTask.ancestor_types);

  // Check 1: Cycle detection
  if (ancestorTypes.includes(targetType.name)) {
    return {
      outcome: 'rejected',
      rejectionKind: 'cycle_detected',
      rejectionDetail: 'Target type already in ancestor chain',
      sameTypeCount,
    };
  }

  // Check 2: Depth limit
  if (parentTask.depth + 1 >= SPECIALISTS_CONFIG.maxSpecialistDepth) {
    return {
      outcome: 'rejected',
      rejectionKind: 'depth_exceeded',
      rejectionDetail: 'Maximum specialist chain depth reached',
      sameTypeCount,
    };
  }

  // Check 3: Chain count limit
  if (
    parentTask.chain_delegation_count >= SPECIALISTS_CONFIG.maxChainDelegations
  ) {
    return {
      outcome: 'rejected',
      rejectionKind: 'count_exceeded',
      rejectionDetail: 'Maximum chain delegation count reached',
      sameTypeCount,
    };
  }

  // Check 4: Same-type dispatch limit
  if (sameTypeCount >= SPECIALISTS_CONFIG.maxSameTypeDispatches) {
    return {
      outcome: 'rejected',
      rejectionKind: 'same_type_limit_exceeded',
      rejectionDetail: 'Maximum dispatches to this specialist type reached',
      sameTypeCount,
    };
  }

  return {
    outcome: 'allowed',
    rejectionKind: null,
    rejectionDetail: null,
    sameTypeCount,
  };
}
