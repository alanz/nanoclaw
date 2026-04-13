import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  updateTaskAfterRun,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  recoverClaimedTasks,
  runTask,
  startSchedulerLoop,
} from './task-scheduler.js';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      clearSession: () => {},
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

// ── recoverClaimedTasks ───────────────────────────────────────────────────────

describe('recoverClaimedTasks', () => {
  const makeQueue = () => ({ enqueueTask: vi.fn() }) as any;
  const makeDeps = (queue: any) => ({
    registeredGroups: () => ({}),
    getSessions: () => ({}),
    clearSession: vi.fn(),
    queue,
    onProcess: vi.fn(),
    sendMessage: vi.fn(async () => {}),
  });

  beforeEach(() => {
    _initTestDatabase();
  });

  it('re-enqueues a recurring task left in claimed state', () => {
    createTask({
      id: 'rec-interval',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'do work',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(), // already advanced by claim
      status: 'active',
      created_at: new Date().toISOString(),
    });
    // Simulate the claim step: last_result = 'claimed', next_run advanced
    updateTaskAfterRun(
      'rec-interval',
      new Date(Date.now() + 60_000).toISOString(),
      'claimed',
    );

    const queue = makeQueue();
    recoverClaimedTasks(makeDeps(queue));

    expect(queue.enqueueTask).toHaveBeenCalledWith(
      'main@g.us',
      'rec-interval',
      expect.any(Function),
    );

    const task = getTaskById('rec-interval');
    expect(task?.last_result).toBe('recovering');
    expect(task?.status).toBe('active');
  });

  it('re-enqueues and reactivates a once task left in claimed state', () => {
    createTask({
      id: 'once-claimed',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 1000).toISOString(),
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    // Claim step marks once tasks as completed (nextRun = null)
    updateTaskAfterRun('once-claimed', null, 'claimed');

    const taskAfterClaim = getTaskById('once-claimed');
    expect(taskAfterClaim?.status).toBe('completed'); // confirm claim behaviour

    const queue = makeQueue();
    recoverClaimedTasks(makeDeps(queue));

    expect(queue.enqueueTask).toHaveBeenCalledWith(
      'main@g.us',
      'once-claimed',
      expect.any(Function),
    );

    const task = getTaskById('once-claimed');
    expect(task?.status).toBe('active');
    expect(task?.last_result).toBe('recovering');
  });

  it('does not re-enqueue tasks that completed normally', () => {
    createTask({
      id: 'normal-done',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'done',
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 1000).toISOString(),
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    updateTaskAfterRun('normal-done', null, 'Task completed successfully');

    const queue = makeQueue();
    recoverClaimedTasks(makeDeps(queue));

    expect(queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('does nothing when no claimed tasks exist', () => {
    const queue = makeQueue();
    recoverClaimedTasks(makeDeps(queue));
    expect(queue.enqueueTask).not.toHaveBeenCalled();
  });
});

// ── runTask sender ────────────────────────────────────────────────────────────

describe('runTask sender', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.resetAllMocks();
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes Scheduler as sender when forwarding task result', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _opts, _onProcess, onOutput) => {
        await onOutput!({ result: 'task output', status: 'success' });
        return { result: 'task output', status: 'success' } as any;
      },
    );

    const task = {
      id: 'sender-test',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'do something',
      schedule_type: 'once' as const,
      schedule_value: new Date(Date.now() - 1000).toISOString(),
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };
    createTask(task);

    const sendMessage = vi.fn(async () => {});

    await runTask(task, {
      registeredGroups: () => ({
        main: {
          name: 'Main',
          folder: 'main',
          trigger: '',
          added_at: '',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      clearSession: vi.fn(),
      queue: {
        enqueueTask: vi.fn(),
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: vi.fn(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'main@g.us',
      'task output',
      'Scheduler',
    );
  });
});

// ── session_reset task type ───────────────────────────────────────────────────

describe('session_reset task type', () => {
  const baseTask = {
    id: 'reset-test',
    group_folder: 'main',
    chat_jid: 'main@g.us',
    prompt: '',
    task_type: 'session_reset' as const,
    min_idle_minutes: 60,
    schedule_type: 'cron' as const,
    schedule_value: '0 4 * * *',
    context_mode: 'isolated' as const,
    next_run: new Date(Date.now() - 1000).toISOString(),
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: new Date().toISOString(),
  };

  const makeDeps = (
    overrides: Partial<{
      sessions: Record<string, string>;
      clearSession: (f: string) => void;
      writeFile: typeof fs.writeFileSync;
    }> = {},
  ) => ({
    registeredGroups: () => ({}) as any,
    getSessions: () => overrides.sessions ?? {},
    clearSession: overrides.clearSession ?? vi.fn(),
    queue: {
      enqueueTask: vi.fn(),
      notifyIdle: vi.fn(),
      closeStdin: vi.fn(),
    } as any,
    onProcess: vi.fn(),
    sendMessage: vi.fn(async () => {}),
  });

  beforeEach(() => {
    _initTestDatabase();
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes IPC task and clears session when group is idle', async () => {
    const clearSession = vi.fn();
    createTask(baseTask);

    // Simulate a chat that was active 90 minutes ago (above 60m threshold)
    const { storeChatMetadata } = await import('./db.js');
    storeChatMetadata(
      'main@g.us',
      new Date(Date.now() - 90 * 60_000).toISOString(),
      'Main',
    );

    await runTask(
      baseTask,
      makeDeps({ sessions: { main: 'sess-abc-123' }, clearSession }),
    );

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('session-archive.json'),
      expect.stringContaining('"type":"request_session_archive"'),
    );
    expect(clearSession).toHaveBeenCalledWith('main');

    const task = getTaskById('reset-test');
    expect(task?.last_result).toMatch(/archived/);
  });

  it('skips and reschedules when group was active recently', async () => {
    const clearSession = vi.fn();
    createTask(baseTask);

    const { storeChatMetadata } = await import('./db.js');
    storeChatMetadata(
      'main@g.us',
      new Date(Date.now() - 10 * 60_000).toISOString(),
      'Main',
    );

    await runTask(
      baseTask,
      makeDeps({ sessions: { main: 'sess-abc-123' }, clearSession }),
    );

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();

    const task = getTaskById('reset-test');
    expect(task?.last_result).toMatch(/Skipped/);
    expect(task?.next_run).not.toBeNull(); // rescheduled to next cron tick
  });

  it('skips when there is no active session', async () => {
    const clearSession = vi.fn();
    createTask(baseTask);

    await runTask(baseTask, makeDeps({ sessions: {}, clearSession }));

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();

    const task = getTaskById('reset-test');
    expect(task?.last_result).toMatch(/no active session/);
  });
});
