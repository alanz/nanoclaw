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
import { getDb, hasTable } from '../../db/connection.js';
import { GROUPS_DIR } from '../../config.js';
import { getSpecialist, getTask, updateTaskStatus } from './db.js';
import { SPECIALISTS_CONFIG } from './config.js';
import { findSessionByAgentGroupAndThread } from './session-helpers.js';
import { endActiveInvocationForSession, expireTransfersForTerminalTask } from './invocation.js';
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

function lastTurnParentNotice(task: SpecialistTask): string {
  if (!task.is_last_same_type_dispatch) return '';
  const specialist = getSpecialist(task.specialist_group_id);
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
    trigger: 1,
  });
  const fresh = getSession(sessionId);
  if (fresh) {
    await wakeContainer(fresh).catch((err) =>
      log.error('specialists: failed to wake container after result routing', { err, taskId }),
    );
  }
}

/** Route a completed or failed root task result to the main group session. */
async function routeResultToMain(task: SpecialistTask, transfer: ContainerTransfer | null): Promise<void> {
  const session = getSession(task.requester_session_id);
  if (!session) {
    log.warn('specialists: cannot route result to main — requester session not found', { taskId: task.id });
    return;
  }

  let content: string;

  if (transfer) {
    if (transfer.commit_to_memory === 1) {
      // Copy files to memory area
      const requesterGroup = task.requester_group_id ? getAgentGroup(task.requester_group_id) : undefined;
      if (requesterGroup) {
        const memDir = path.join(GROUPS_DIR, requesterGroup.folder, SPECIALISTS_CONFIG.memoryReportsSubpath);
        fs.mkdirSync(memDir, { recursive: true });

        if (hasTable(getDb(), 'transfer_files')) {
          const files = getDb()
            .prepare("SELECT * FROM transfer_files WHERE transfer_id = ? AND status = 'owned'")
            .all(transfer.id) as TransferFile[];

          const memoryPaths: string[] = [];
          for (const file of files) {
            const destPath = path.join(memDir, file.original_name);
            try {
              fs.copyFileSync(file.host_path, destPath);
              const memPath = `${SPECIALISTS_CONFIG.memoryReportsSubpath}/${file.original_name}`;
              getDb()
                .prepare("UPDATE transfer_files SET status = 'placed', memory_path = ? WHERE id = ?")
                .run(memPath, file.id);
              memoryPaths.push(memPath);
            } catch (err) {
              log.warn('specialists: failed to copy file to memory area', {
                transferId: transfer.id,
                file: file.original_name,
                err,
              });
            }
          }

          // Set committed_files on task
          if (memoryPaths.length > 0) {
            getDb()
              .prepare('UPDATE specialist_tasks SET committed_files = ? WHERE id = ?')
              .run(JSON.stringify(memoryPaths), task.id);
          }
        }

        // Mark transfer committed then immediately expired (memory copies persist)
        getDb()
          .prepare("UPDATE container_transfers SET status = 'committed' WHERE id = ?")
          .run(transfer.id);
        getDb()
          .prepare("UPDATE container_transfers SET status = 'expired' WHERE id = ?")
          .run(transfer.id);
      } else {
        log.warn('specialists: requester group not found for memory commit', {
          taskId: task.id,
          requesterGroupId: task.requester_group_id,
        });
      }
      content = transfer.result_text;
    } else {
      // Stage for ipc-in delivery when requester container starts
      getDb()
        .prepare('UPDATE container_transfers SET recipient_session_id = ? WHERE id = ?')
        .run(session.id, transfer.id);
      content = transfer.result_text;
    }
  } else {
    content = formatOutcome(task) + lastTurnParentNotice(task);
  }

  await sendToSession(session.agent_group_id, session.id, content, task.id);
}

/** Route a sub-task result to the parent specialist's per-task session, resuming the parent. */
async function routeResultToParent(
  task: SpecialistTask,
  parentTask: SpecialistTask,
  transfer: ContainerTransfer | null,
): Promise<void> {
  const parentSession = findSessionByAgentGroupAndThread(parentTask.specialist_group_id, parentTask.id);
  if (!parentSession) {
    log.warn('specialists: cannot route result to parent — parent session not found', {
      taskId: task.id,
      parentTaskId: parentTask.id,
    });
    return;
  }
  updateTaskStatus(parentTask.id, 'running', { pending_sub_task_id: null });

  let content: string;

  if (transfer) {
    // Stage for ipc-in delivery to parent session
    getDb()
      .prepare('UPDATE container_transfers SET recipient_session_id = ? WHERE id = ?')
      .run(parentSession.id, transfer.id);
    content = transfer.result_text;
  } else {
    content = formatOutcome(task) + lastTurnParentNotice(task);
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
  const specialistSession = findSessionByAgentGroupAndThread(task.specialist_group_id, task.id);
  if (specialistSession) {
    endActiveInvocationForSession(specialistSession.id);
  }

  if (task.requester_group_id) {
    await routeResultToMain(task, transfer);
    expireTransfersForTerminalTask(task.id);
    return;
  }
  if (!task.requester_task_id) return;

  const parent = getTask(task.requester_task_id);
  if (!parent) {
    log.warn('specialists: parent task not found for sub-task routing', {
      taskId: task.id,
      requesterTaskId: task.requester_task_id,
    });
    return;
  }
  if (parent.status !== 'awaiting_sub_task') return;
  await routeResultToParent(task, parent, transfer);
  expireTransfersForTerminalTask(task.id);
}
