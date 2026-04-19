import type { NewMessage } from './types.js';
import { logger } from './logger.js';

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  if (text === '/compact') return '/compact';
  if (text === '/reset') return '/reset';
  if (text.startsWith('/retry-summary')) return text;
  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), trusted group (any sender), or is_from_me sender in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
  isTrustedGroup: boolean = false,
): boolean {
  return isMainGroup || isTrustedGroup || isFromMe;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  clearSession: () => void;
  /** Current session ID — used to reference the .jsonl log in the summary note. */
  sessionId?: string;
  /** Custom summarisation prompt read from prompts/reset-prompt.md — overrides the default. */
  resetPrompt?: string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Chat JID of the group — passed to throwaway session spawner via IPC. */
  chatJid: string;
  /** Group folder name — used to identify the group in the IPC task. */
  groupFolder: string;
  /** Write an IPC task file to the group's host-side tasks directory. */
  writeIpcTask: (task: object) => void;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  isTrustedGroup?: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    isTrustedGroup = false,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (
    !isSessionCommandAllowed(
      isMainGroup,
      cmdMsg.is_from_me === true,
      isTrustedGroup,
    )
  ) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
  logger.info({ group: groupName, command }, 'Session command');

  // Handle /retry-summary: re-queue a failed throwaway session summary via IPC.
  if (command?.startsWith('/retry-summary')) {
    const targetSessionId = command.slice('/retry-summary'.length).trim();
    if (!targetSessionId) {
      await deps.sendMessage('Usage: /retry-summary <session_id>');
      deps.advanceCursor(cmdMsg.timestamp);
      return { handled: true, success: true };
    }
    deps.writeIpcTask({
      type: 'retry_throwaway_summary',
      jid: deps.chatJid,
      sessionId: targetSessionId,
      groupFolder: deps.groupFolder,
      timestamp: new Date().toISOString(),
    });
    logger.info(
      { group: groupName, targetSessionId },
      'Requested throwaway retry via IPC',
    );
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // Handle /reset: archive the transcript and clear the session immediately.
  // A throwaway agent session is spawned asynchronously by the host via IPC
  // to generate the SessionSummary (memory/sessions/). The ⏳ reaction is
  // emitted by the host when it processes the request_session_archive task.
  if (command === '/reset') {
    if (deps.sessionId) {
      deps.writeIpcTask({
        type: 'request_session_archive',
        jid: deps.chatJid,
        sessionId: deps.sessionId,
        groupFolder: deps.groupFolder,
        timestamp: new Date().toISOString(),
      });
      logger.info(
        { group: groupName, sessionId: deps.sessionId },
        'Requested session archive via IPC',
      );
    } else {
      logger.warn({ group: groupName }, '/reset issued with no active session');
    }

    deps.clearSession();
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
    // Send ✅ on success — runAgent only resolves when the container exits, not here.
    if (result.status === 'success') await deps.setTyping(false);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
