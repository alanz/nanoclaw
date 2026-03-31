import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects bare /reset', () => {
    expect(extractSessionCommand('/reset', trigger)).toBe('/reset');
  });

  it('detects /reset with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /reset', trigger)).toBe('/reset');
  });

  it('rejects /reset with extra text', () => {
    expect(extractSessionCommand('/reset now', trigger)).toBeNull();
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    clearSession: vi.fn(),
    canSenderInteract: vi.fn().mockReturnValue(true),
    ...overrides,
  } as SessionCommandDeps;
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('/reset: summarises session, clears session, advances cursor', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({
          status: 'success',
          result:
            'Saved summary to memory/notes/MEM-2026-03-31-session-reset-1200.md',
        });
        await onOutput({ status: 'success', result: null });
        return 'success';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/reset', { timestamp: '200' })],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledOnce();
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.advanceCursor).toHaveBeenCalledWith('200');
    // Summary text forwarded to user, no extra "Session cleared" message
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Saved summary'),
    );
  });

  it('/reset: aborts and does not clear session when summarisation fails', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/reset', { timestamp: '200' })],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.advanceCursor).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Could not save session summary'),
    );
  });

  it('/reset: includes session metadata in prompt when sessionId provided', async () => {
    let capturedPrompt = '';
    const deps = makeDeps({
      sessionId: 'abc123',
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        capturedPrompt = prompt;
        await onOutput({ status: 'success', result: null });
        return 'success';
      }),
    });
    await handleSessionCommand({
      missedMessages: [makeMsg('/reset', { timestamp: '200' })],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(capturedPrompt).toContain('abc123');
    expect(capturedPrompt).toContain(
      '/home/node/.claude/projects/-workspace-group/abc123.jsonl',
    );
    expect(capturedPrompt).toContain('abc123.jsonl');
    expect(capturedPrompt).not.toContain('~/.claude/projects/');
    expect(capturedPrompt).toContain('Session ended at:');
  });

  it('/reset: uses custom resetPrompt when provided', async () => {
    let capturedPrompt = '';
    const deps = makeDeps({
      resetPrompt: 'Only record code decisions.',
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        capturedPrompt = prompt;
        await onOutput({ status: 'success', result: null });
        return 'success';
      }),
    });
    await handleSessionCommand({
      missedMessages: [makeMsg('/reset', { timestamp: '200' })],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(capturedPrompt).toContain('Only record code decisions.');
    expect(capturedPrompt).not.toContain('key decisions made');
    // sessionMeta still appended
    expect(capturedPrompt).toContain('Session ended at:');
  });

  it('/reset: sends fallback confirmation when agent returns no text', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'success';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/reset', { timestamp: '200' })],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session cleared. Next message starts fresh.',
    );
  });
});
