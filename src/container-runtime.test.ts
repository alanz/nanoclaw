import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  listOrphanedContainers,
  isContainerRunning,
  killContainer,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} system status`,
      { stdio: 'pipe' },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('auto-starts when system status fails', () => {
    // First call (system status) fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    // Second call (system start) succeeds
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} system start`,
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- listOrphanedContainers ---

// CF epoch offset: Jan 1, 2001 is 978307200 seconds after Unix epoch
const CF_OFFSET_S = 978307200;

describe('listOrphanedContainers', () => {
  it('returns running nanoclaw containers with parsed safeName and startedMs', () => {
    const startedDate = 800000000; // arbitrary CF timestamp
    const lsOutput = JSON.stringify([
      {
        status: 'running',
        startedDate,
        configuration: { id: 'nanoclaw-main-1773496586126' },
      },
      {
        status: 'stopped',
        startedDate,
        configuration: { id: 'nanoclaw-group2-1773496586200' },
      },
      {
        status: 'running',
        startedDate,
        configuration: { id: 'other-container' },
      },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);

    const result = listOrphanedContainers();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('nanoclaw-main-1773496586126');
    expect(result[0].safeName).toBe('main');
    expect(result[0].startedMs).toBe((startedDate + CF_OFFSET_S) * 1000);
  });

  it('returns empty array when no orphans', () => {
    mockExecSync.mockReturnValueOnce('[]');
    expect(listOrphanedContainers()).toEqual([]);
  });

  it('returns empty array when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('runtime not available');
    });
    expect(listOrphanedContainers()).toEqual([]);
  });

  it('falls back to now for missing startedDate', () => {
    const before = Date.now();
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-x-1000000000000' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);

    const result = listOrphanedContainers();
    const after = Date.now();

    expect(result[0].startedMs).toBeGreaterThanOrEqual(before);
    expect(result[0].startedMs).toBeLessThanOrEqual(after);
  });
});

// --- isContainerRunning ---

describe('isContainerRunning', () => {
  it('returns true when container is in running state', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { status: 'running', configuration: { id: 'nanoclaw-main-123' } },
      ]),
    );
    expect(isContainerRunning('nanoclaw-main-123')).toBe(true);
  });

  it('returns false when container is not listed', () => {
    mockExecSync.mockReturnValueOnce(JSON.stringify([]));
    expect(isContainerRunning('nanoclaw-main-123')).toBe(false);
  });

  it('returns false when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('runtime not available');
    });
    expect(isContainerRunning('nanoclaw-main-123')).toBe(false);
  });
});

// --- killContainer ---

describe('killContainer', () => {
  it('calls container stop with the given name', () => {
    mockExecSync.mockReturnValueOnce('');
    killContainer('nanoclaw-main-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-main-123`,
      { stdio: 'pipe' },
    );
  });

  it('does not throw when container already stopped', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    expect(() => killContainer('nanoclaw-main-123')).not.toThrow();
  });
});
