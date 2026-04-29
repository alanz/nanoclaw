export type SpecialistTaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_sub_task'
  | 'awaiting_restart'
  | 'completed'
  | 'failed';

export type SpecialistFailureKind =
  | 'cycle_detected'
  | 'depth_exceeded'
  | 'count_exceeded'
  | 'same_type_limit_exceeded'
  | 'timeout'
  | 'execution_error'
  | 'host_restart';

export interface TaskFailure {
  kind: SpecialistFailureKind;
  detail: string;
}

export interface Specialist {
  agent_group_id: string;
  is_memory_provider: number; // 0 | 1
  last_turn_sub_notice: string | null;
  last_turn_parent_notice: string | null;
  created_at: string;
}

export interface SpecialistTask {
  id: string;
  specialist_group_id: string;
  prompt: string;
  requester_group_id: string | null; // set for root tasks (dispatched by main group)
  requester_task_id: string | null; // set for sub-tasks (dispatched by another specialist)
  requester_session_id: string; // original dispatching session — used for result routing
  depth: number;
  chain_delegation_count: number;
  ancestor_group_ids: string; // JSON-encoded string[]
  is_last_same_type_dispatch: number; // 0 | 1
  status: SpecialistTaskStatus;
  dispatched_at: string;
  restart_attempt_count: number;
  closed_at: string | null;
  result: string | null; // present when status = 'completed'
  failure_kind: string | null; // present when status = 'failed'
  failure_detail: string | null;
  pending_sub_task_id: string | null; // present when status = 'awaiting_sub_task'
}
