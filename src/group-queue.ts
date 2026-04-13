import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';

export interface GroupQueueStatus {
  activeCount: number;
  maxConcurrent: number;
  waitingCount: number;
  groups: Array<{
    jid: string;
    active: boolean;
    idleWaiting: boolean;
    isTaskContainer: boolean;
    runningTaskId: string | null;
    pendingMessages: boolean;
    pendingTaskCount: number;
    containerName: string | null;
    groupFolder: string | null;
    retryCount: number;
  }>;
}
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  mainGroupJid: string | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    const isMain = groupJid === this.mainGroupJid;

    if (!isMain && this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    const isMain = groupJid === this.mainGroupJid;

    if (!isMain && this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /** Clear process registration for a background container (e.g. throwaway) once it exits. */
  deregisterProcess(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state || state.active) return; // don't clear if group is actively processing
    state.process = null;
    state.containerName = null;
    state.groupFolder = null;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send an interrupt signal to the active container.
   * The container will end its current query and use the text as the next prompt.
   * Returns true if the interrupt was written, false if no active container.
   */
  sendInterrupt(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'interrupt', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /** Whether this JID counts against the concurrency limit. */
  private countsAgainstLimit(groupJid: string): boolean {
    return groupJid !== this.mainGroupJid;
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    if (this.countsAgainstLimit(groupJid)) this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      if (this.countsAgainstLimit(groupJid)) this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    if (this.countsAgainstLimit(groupJid)) this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      if (this.countsAgainstLimit(groupJid)) this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    // Prioritize the main group in the waiting list
    if (this.mainGroupJid) {
      const idx = this.waitingGroups.indexOf(this.mainGroupJid);
      if (idx > 0) {
        this.waitingGroups.splice(idx, 1);
        this.waitingGroups.unshift(this.mainGroupJid);
      }
    }

    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  /**
   * Adopt an orphaned container from a previous NanoClaw process.
   *
   * Marks the group as active (blocking new containers from starting) and
   * signals the orphan to wind down gracefully via the _close sentinel.
   * Polls until the container exits, then releases the group slot.
   * Falls back to a force-kill after remainingMs if it hasn't exited.
   *
   * This avoids calling `container stop` at startup, which tears down the VM
   * and fires a macOS SCNetworkReachability event that causes Tailscale to
   * re-establish its WireGuard session (~30–60s SSH freeze on every restart).
   */
  adoptOrphan(
    groupJid: string,
    containerName: string,
    groupFolder: string,
    isRunning: (name: string) => boolean,
    forceKill: (name: string) => void,
  ): void {
    const state = this.getGroup(groupJid);
    if (state.active) return; // already active, nothing to adopt

    state.active = true;
    // Do not increment activeCount — the orphan doesn't hold a concurrency slot
    // against other groups; it only blocks its own group from starting a new container.

    // Signal the orphan to wind down gracefully
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      /* ignore — orphan may already have exited */
    }

    // Give the orphan a grace window to flush state and exit naturally after
    // receiving _close. Apple Container VMs can linger in "running" state after
    // the entrypoint exits, so we cap this rather than waiting for the full
    // remaining timeout. 20 minutes is enough for any in-flight agent work.
    const GRACE_MS = 2 * 60_000;
    logger.info(
      { groupJid, containerName, graceMs: GRACE_MS },
      'Adopting orphaned container — waiting for natural exit',
    );

    const POLL_MS = 5_000;
    const deadline = Date.now() + GRACE_MS;

    const release = () => {
      state.active = false;
      this.drainGroup(groupJid);
    };

    const poll = () => {
      if (this.shuttingDown) return;

      if (!isRunning(containerName)) {
        logger.info(
          { groupJid, containerName },
          'Orphaned container exited — releasing group slot',
        );
        release();
        return;
      }

      if (Date.now() >= deadline) {
        logger.warn(
          { groupJid, containerName },
          'Orphaned container exceeded timeout — force stopping',
        );
        forceKill(containerName);
        release();
        return;
      }

      setTimeout(poll, POLL_MS);
    };

    setTimeout(poll, POLL_MS);
  }

  getStatus(): GroupQueueStatus {
    const groups = [];
    for (const [jid, state] of this.groups) {
      if (
        state.active ||
        state.pendingMessages ||
        state.pendingTasks.length > 0 ||
        state.containerName !== null // background container (e.g. throwaway)
      ) {
        groups.push({
          jid,
          active: state.active,
          idleWaiting: state.idleWaiting,
          isTaskContainer: state.isTaskContainer,
          runningTaskId: state.runningTaskId,
          pendingMessages: state.pendingMessages,
          pendingTaskCount: state.pendingTasks.length,
          containerName: state.containerName,
          groupFolder: state.groupFolder,
          retryCount: state.retryCount,
        });
      }
    }
    return {
      activeCount: this.activeCount,
      maxConcurrent: MAX_CONCURRENT_CONTAINERS,
      waitingCount: this.waitingGroups.length,
      groups,
    };
  }

  /** All container names currently registered with the queue (active or not). */
  getTrackedContainerNames(): Set<string> {
    const names = new Set<string>();
    for (const state of this.groups.values()) {
      if (state.containerName) names.add(state.containerName);
    }
    return names;
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Signal all active containers to wind down gracefully via _close, then
    // detach without killing. The container finishes its current query and exits
    // on its own; the --rm flag cleans it up. On the next startup, any container
    // that hasn't yet exited is adopted as an orphan, but idle containers will
    // typically exit before the new process even starts.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
      if (state.groupFolder) {
        const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
        try {
          fs.mkdirSync(inputDir, { recursive: true });
          fs.writeFileSync(path.join(inputDir, '_close'), '');
        } catch {
          // ignore — container may already have exited
        }
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers signalled and detached)',
    );
  }
}
