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
import { handleDispatchSpecialist, handleDispatchSubTask } from './dispatch.js';
import { handleDeliverSpecialistResult } from './delivery.js';

registerDeliveryAction('dispatch_specialist', handleDispatchSpecialist);
registerDeliveryAction('dispatch_sub_task', handleDispatchSubTask);
registerDeliveryAction('deliver_specialist_result', handleDeliverSpecialistResult);

export { sweepSpecialistTasks } from './recovery.js';
export { createSpecialist, setMainGroup } from './db.js';
