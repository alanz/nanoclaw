/**
 * Result routing: delivers a completed/failed specialist task result back to
 * its requester (either the main group's session or the parent specialist's
 * per-task session).
 */
import path from 'path';
import fs from 'fs';

import { getSession } from '../../db/sessions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { wakeContainer } from '../../container-runner.js';
import { writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { GROUPS_DIR } from '../../config.js';
import { getSpecialist, getTask, updateTaskStatus } from './db.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { closeSpecialistSession, findSessionByAgentGroupAndThread } from './session-helpers.js';
import {
  endActiveInvocationForSession,
  expireTransfersForTerminalTask,
  placeTransferIntoActiveIpcIn,
  reclaimTransferStaging,
} from './invocation.js';
import type { ContainerTransfer, SpecialistTask, TransferFile } from './types.js';

function generateId(): string {
  return `spec-res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatOutcome(task: SpecialistTask): string {
  if (task.status === 'completed' && task.result) return task.result;
  const kind = task.failure_kind ?? 'unknown';
  const detail = task.failure_detail ?? '';
  return `Specialist task failed: ${kind}${detail ? ` — ${detail}` : ''}`;
}

async function lastTurnParentNotice(task: SpecialistTask): Promise<string> {
  if (!task.is_last_same_type_dispatch) return '';
  const specialist = await getSpecialist(task.specialist_group_id);
  return `\n\n${specialist?.last_turn_parent_notice ?? SPECIALISTS_CONFIG.defaultLastTurnParentNotice}`;
}

async function sendToSession(agentGroupId: string, sessionId: string, text: string, taskId: string): Promise<void> {
  writeSessionMessage(agentGroupId, sessionId, {
    id: generateId(),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      text,
      sender: 'system',
      senderId: 'system',
      completedSpecialistTaskId: taskId,
    }),
    trigger: true,
  });
  const fresh = await getSession(sessionId);
  if (fresh) {
    await wakeContainer(fresh).catch((err) =>
      log.error('specialists: failed to wake container after result routing', { err, taskId }),
    );
  }
}

/** Route a completed or failed root task result to the main group session. */
async function routeResultToMain(task: SpecialistTask, transfer: ContainerTransfer | null): Promise<void> {
  const session = await getSession(task.requester_session_id);
  if (!session) {
    log.warn('specialists: cannot route result to main — requester session not found', { taskId: task.id });
    return;
  }

  let content: string;

  if (transfer) {
    if (transfer.commit_to_memory === 1) {
      // Copy files to memory area
      const requesterGroup = task.requester_group_id ? await getAgentGroup(task.requester_group_id) : undefined;
      if (requesterGroup) {
        const memDir = path.join(GROUPS_DIR, requesterGroup.folder, SPECIALISTS_CONFIG.memoryReportsSubpath);
        fs.mkdirSync(memDir, { recursive: true });

        const db = getDb();
        // Copy first; the record of where each file went is written below in
        // one step with the transfer's status.
        const outcomes: Array<{ id: string; memoryPath: string | null }> = [];
        if (await db.hasTable('transfer_files')) {
          const files = (await db.all(
            "SELECT * FROM transfer_files WHERE transfer_id = ? AND status = 'owned'",
            transfer.id,
          )) as TransferFile[];
          for (const file of files) {
            const destPath = path.join(memDir, file.original_name);
            try {
              fs.copyFileSync(file.host_path, destPath);
              outcomes.push({
                id: file.id,
                memoryPath: `${SPECIALISTS_CONFIG.memoryReportsSubpath}/${file.original_name}`,
              });
            } catch (err) {
              log.warn('specialists: failed to copy file to memory area', {
                transferId: transfer.id,
                file: file.original_name,
                err,
              });
              outcomes.push({ id: file.id, memoryPath: null });
            }
          }
        }
        const memoryPaths = outcomes.flatMap((o) => (o.memoryPath ? [o.memoryPath] : []));

        // specialists.allium's commit is one operation: record each file's
        // memory_path, the task's committed_files, and take the transfer
        // pending → committed → expired. Two separate writes left a window
        // where a crash stranded it in the transient `committed`.
        //
        // A committed file ends `expired`, not `placed`: it was never placed
        // into an ipc-in, its staging copy is reclaimed, and memory_path
        // records the copy that persists. (The spec's file transitions list
        // no owned → expired — a spec gap, raised separately.)
        await db.transaction(async () => {
          for (const { id, memoryPath } of outcomes) {
            await db.run("UPDATE transfer_files SET status = 'expired', memory_path = ? WHERE id = ?", memoryPath, id);
          }
          if (memoryPaths.length > 0) {
            await db.run(
              'UPDATE specialist_tasks SET committed_files = ? WHERE id = ?',
              JSON.stringify(memoryPaths),
              task.id,
            );
          }
          await db.run("UPDATE container_transfers SET status = 'committed' WHERE id = ?", transfer.id);
          await db.run("UPDATE container_transfers SET status = 'expired' WHERE id = ?", transfer.id);
        });
        // The spec's commit reclaims the staging copies at once: the memory
        // copies are what persist, and no ipc-in will ever want them.
        reclaimTransferStaging(transfer.id);
      } else {
        log.warn('specialists: requester group not found for memory commit', {
          taskId: task.id,
          requesterGroupId: task.requester_group_id,
        });
      }
      content = transfer.result_text;
    } else {
      // Stage for ipc-in delivery when requester container starts.
      // Also populate into the active ipc-in if the container is already running —
      // _populateIpcIn at spawn time may have run before this transfer was created.
      await getDb().run(
        'UPDATE container_transfers SET recipient_session_id = ? WHERE id = ?',
        session.id,
        transfer.id,
      );
      await placeTransferIntoActiveIpcIn(session.id, { ...transfer, recipient_session_id: session.id });
      content = transfer.result_text;
    }
  } else {
    content = formatOutcome(task) + (await lastTurnParentNotice(task));
  }

  await sendToSession(session.agent_group_id, session.id, content, task.id);
}

/** Route a sub-task result to the parent specialist's per-task session, resuming the parent. */
async function routeResultToParent(
  task: SpecialistTask,
  parentTask: SpecialistTask,
  transfer: ContainerTransfer | null,
): Promise<void> {
  const parentSession = await findSessionByAgentGroupAndThread(parentTask.specialist_group_id, parentTask.id);
  if (!parentSession) {
    log.warn('specialists: cannot route result to parent — parent session not found', {
      taskId: task.id,
      parentTaskId: parentTask.id,
    });
    return;
  }
  await updateTaskStatus(parentTask.id, 'running', { pending_sub_task_id: null });

  let content: string;

  if (transfer) {
    // Stage for ipc-in delivery to parent session.
    // Also populate into the active ipc-in if the parent container is already running.
    await getDb().run(
      'UPDATE container_transfers SET recipient_session_id = ? WHERE id = ?',
      parentSession.id,
      transfer.id,
    );
    await placeTransferIntoActiveIpcIn(parentSession.id, { ...transfer, recipient_session_id: parentSession.id });
    content = transfer.result_text;
  } else {
    content = formatOutcome(task) + (await lastTurnParentNotice(task));
  }

  await sendToSession(parentSession.agent_group_id, parentSession.id, content, task.id);
}

/**
 * Route the result of a terminal task to its requester.
 * Immediately-rejected sub-tasks (cycle/depth/count/same-type) are skipped:
 * the parent never entered awaiting_sub_task, and AgentNotified was already
 * sent by the rejection handler.
 *
 * @param transfer - Optional ContainerTransfer created by the delivery handler.
 *   Existing callers (recovery.ts, dispatch.ts) pass no transfer — the default
 *   null keeps them working unchanged.
 */
export async function routeResult(task: SpecialistTask, transfer: ContainerTransfer | null = null): Promise<void> {
  // End the specialist's active invocation now that the task is terminal.
  // This is more reliable than relying on the container close event, which
  // may not fire promptly on all runtimes (e.g. Apple Container).
  const specialistSession = await findSessionByAgentGroupAndThread(task.specialist_group_id, task.id);
  if (specialistSession) {
    // Awaited, so the run's cleanup is done before the session closes — and a
    // failure here is logged rather than escaping as an unhandled rejection,
    // without stopping the close and routing that follow.
    try {
      await endActiveInvocationForSession(specialistSession.id);
    } catch (err) {
      log.warn('specialists: ending the invocation failed', { taskId: task.id, sessionId: specialistSession.id, err });
    }
    await closeSpecialistSession(specialistSession);
  }

  if (task.requester_group_id) {
    await routeResultToMain(task, transfer);
    await expireTransfersForTerminalTask(task.id);
    return;
  }
  if (!task.requester_task_id) return;

  const parent = await getTask(task.requester_task_id);
  if (!parent) {
    log.warn('specialists: parent task not found for sub-task routing', {
      taskId: task.id,
      requesterTaskId: task.requester_task_id,
    });
    return;
  }
  if (parent.status !== 'awaiting_sub_task') return;
  await routeResultToParent(task, parent, transfer);
  await expireTransfersForTerminalTask(task.id);
}
