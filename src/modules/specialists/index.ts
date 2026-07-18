/**
 * Specialists module — host-side wiring.
 *
 * Registers three delivery actions (system actions written by agent
 * containers to their outbound DB and picked up by the host delivery loop):
 *
 *   dispatch_specialist     — main group requests a root specialist task
 *   dispatch_sub_task       — specialist delegates to another specialist
 *   deliver_specialist_result — specialist delivers its final answer
 *
 * Also exports sweepSpecialistTasks() for use by host-sweep.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleDispatchSpecialist, handleDispatchSubTask } from './dispatch.js';
import { handleDeliverSpecialistResult } from './delivery.js';

// Internal specialist orchestration between the operator's own agent groups —
// dispatch/sub-task/result routing is not externally reachable and ran
// unguarded before the delivery-action guard system existed. Keep it unguarded
// so specialists can delegate autonomously without approval deadlock.
registerDeliveryAction(
  'dispatch_specialist',
  handleDispatchSpecialist,
  unguarded('internal specialist orchestration; not externally reachable'),
);
registerDeliveryAction(
  'dispatch_sub_task',
  handleDispatchSubTask,
  unguarded('internal specialist-to-specialist delegation; not externally reachable'),
);
registerDeliveryAction(
  'deliver_specialist_result',
  handleDeliverSpecialistResult,
  unguarded('internal specialist result delivery; not externally reachable'),
);

export { sweepSpecialistTasks } from './recovery.js';
export { createSpecialist, setMainGroup } from './db.js';
