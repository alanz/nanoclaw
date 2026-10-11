/**
 * Specialist messages to the user (specs/null-channel.allium
 * SpecialistProgressRelayed, SpecialistCardRelayed, SpecialistAnswerCopied).
 *
 * As in v1, a specialist talks to the user through the chat of the task
 * chain's root requester, shown as coming from the specialist ("Researcher"):
 *
 *   - every specialist session gets one destination, `requester`, aimed at its
 *     own null-channel chat, so send_message / <message to="requester"> pass
 *     delivery like any reply to the session's origin chat;
 *   - once delivery has handed such a message to the null adapter (a no-op),
 *     the post-delivery hook below relays it to the root requester's chat and
 *     leaves a non-waking copy in the root requester's session;
 *   - questions and cards (ask_user_question, send_card) take the same path.
 *     The question stays the specialist's (pending_questions points at its
 *     session), so the user's answer goes back to the specialist; the main
 *     agent gets a copy of the answer too.
 *
 * In v2 a turn's plain text is never delivered (only <message to> blocks and
 * send_message), so every chat message on the null channel is deliberate —
 * except the runner's failure notices, which are not relayed.
 */
import { getNullMessagingGroupId, NULL_CHANNEL_PLATFORM_ID, NULL_CHANNEL_TYPE } from '../../channels/null-channel.js';
import { registerSessionContributor } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getPendingQuestion, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter, registerPostDeliveryHook } from '../../delivery.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { log } from '../../log.js';
import type { Destination } from '../../mailbox/index.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { withMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getTask } from './db.js';
import type { SpecialistTask } from './types.js';

export const REQUESTER_DESTINATION = 'requester';
/** The runner's marker on a failure notice (container formatter.ts FAILURE_NOTICE_FIELD). */
const FAILURE_NOTICE_FIELD = 'failureNotice';
/** Bound on walking requester_task links; chains are capped far below this. */
const MAX_CHAIN = 32;

async function isSpecialistSession(session: Pick<Session, 'messaging_group_id'>): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  try {
    return session.messaging_group_id === (await getNullMessagingGroupId());
  } catch {
    return false; // null channel not set up: no specialist sessions exist
  }
}

/** The task a specialist session works for: thread_id = task.id, in that group. */
async function taskForSession(session: Session): Promise<SpecialistTask | undefined> {
  if (!session.thread_id) return undefined;
  const task = await getTask(session.thread_id);
  return task && task.specialist_group_id === session.agent_group_id ? task : undefined;
}

/** specialists.allium SpecialistTask.root_requester_session. */
export async function rootRequesterSession(task: SpecialistTask): Promise<Session | undefined> {
  let current = task;
  for (let i = 0; i < MAX_CHAIN && current.requester_task_id; i++) {
    const parent = await getTask(current.requester_task_id);
    if (!parent) return undefined;
    current = parent;
  }
  return current.requester_task_id ? undefined : getSession(current.requester_session_id);
}

// ── The `requester` destination ──────────────────────────────────────────────

const REQUESTER: Destination = {
  name: REQUESTER_DESTINATION,
  displayName: 'the user who asked for this task (progress updates; shown as coming from you)',
  type: 'channel',
  channelType: NULL_CHANNEL_TYPE,
  platformId: NULL_CHANNEL_PLATFORM_ID,
  agentGroupId: null,
};

// Runs after core wrote the session's destination map from agent_destinations:
// a specialist's map is exactly `requester` (null-channel.allium — a specialist
// cannot name any other destination).
registerSessionContributor(async ({ session }) => {
  if (!(await isSpecialistSession(session)) || !(await taskForSession(session))) return undefined;
  await withMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.replaceDestinations([REQUESTER]));
  return undefined;
});

// ── Relay ────────────────────────────────────────────────────────────────────

interface RelayTarget {
  task: SpecialistTask;
  root: Session;
  sender: string;
}

async function relayTarget(session: Session): Promise<RelayTarget | null> {
  if (!(await isSpecialistSession(session))) return null;
  const task = await taskForSession(session);
  if (!task) return null;
  const root = await rootRequesterSession(task);
  if (!root) return null;
  const sender = (await getAgentGroup(task.specialist_group_id))?.name ?? 'Specialist';
  return { task, root, sender };
}

function describeCard(content: Record<string, unknown>): string {
  if (content.type === 'ask_question') {
    const options = Array.isArray(content.options)
      ? content.options
          .map((o) => (typeof o === 'string' ? o : String((o as { label?: unknown }).label ?? '')))
          .join(' / ')
      : '';
    return `asked the user: ${String(content.title ?? '')}${content.question ? ` — ${String(content.question)}` : ''}${options ? ` (options: ${options})` : ''}`;
  }
  const card = (content.card ?? {}) as { title?: unknown };
  return `sent the user a card: ${String(content.fallbackText || card.title || '(card)')}`;
}

async function copyToRequester(target: RelayTarget, id: string, text: string): Promise<void> {
  const { root, sender, task } = target;
  const mg = root.messaging_group_id ? await getMessagingGroup(root.messaging_group_id) : undefined;
  await writeSessionMessage(root.agent_group_id, root.id, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: mg?.platform_id ?? null,
    channelType: mg?.channel_type ?? null,
    threadId: root.thread_id,
    content: JSON.stringify({ text: `[${sender} ${text}]`, sender, senderId: `specialist:${task.id}` }),
    trigger: false,
  });
}

/** Post-delivery hook: relay a specialist's message or card to its root requester. */
export async function relaySpecialistMessage(msg: OutboundMessage, session: Session): Promise<void> {
  if (msg.channelType !== NULL_CHANNEL_TYPE) return;
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return;
  const content = JSON.parse(msg.content) as Record<string, unknown>;
  if (content[FAILURE_NOTICE_FIELD] || content.operation) return;

  const target = await relayTarget(session);
  if (!target) return;
  const { root, sender, task } = target;
  const mg = root.messaging_group_id ? await getMessagingGroup(root.messaging_group_id) : undefined;
  if (!mg) {
    log.warn('specialists: message dropped — the requester has no chat to relay to', {
      taskId: task.id,
      messageId: msg.id,
    });
    return;
  }
  const adapter = getDeliveryAdapter();
  if (!adapter) return;

  const relayed: Record<string, unknown> = { ...content, sender };
  // Adapters that show a per-message sender name use `sender`; elsewhere the
  // name goes in front of the text.
  if (msg.kind === 'chat' && mg.channel_type !== 'deltachat' && typeof relayed.text === 'string') {
    relayed.text = `[${sender}] ${relayed.text}`;
  }
  await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    root.thread_id,
    msg.kind,
    JSON.stringify(relayed),
    undefined,
    mg.instance,
  );
  log.info('specialists: message relayed to requester', { taskId: task.id, messageId: msg.id, kind: msg.kind });

  const copy =
    msg.kind === 'chat'
      ? `told the user: ${typeof content.text === 'string' ? content.text : ''}`
      : describeCard(content);
  await copyToRequester(target, `spec-relay-${msg.id}`, copy);
}

registerPostDeliveryHook(relaySpecialistMessage);

// The user answered a relayed question: copy the answer to the main agent too.
// Prepended and never claiming, so the interactive module still routes the
// answer to the specialist.
export async function copySpecialistAnswer(payload: ResponsePayload): Promise<boolean> {
  const pq = await getPendingQuestion(payload.questionId);
  if (!pq) return false;
  const session = await getSession(pq.session_id);
  if (!session) return false;
  const target = await relayTarget(session);
  if (!target) return false;
  const option = pq.options.find((o) => o.value === payload.value);
  await copyToRequester(
    target,
    `spec-answer-${payload.questionId}`,
    `asked "${pq.title}"; the user chose: ${option?.label ?? payload.value}`,
  );
  return false;
}

registerResponseHandler(copySpecialistAnswer, { prepend: true });
