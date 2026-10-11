/**
 * Question cards on DeltaChat, which has no buttons (specs/agent-to-agent.allium
 * "Answering by reply").
 *
 * A card (ask_user_question, or an approval) is sent as text with numbered
 * options, and the user answers by replying. A reply answers a card when it
 * quotes that card, or, unquoted, when exactly one card is still waiting in
 * that chat; its text must name an option by number or label. An unquoted
 * option-like reply while several cards are waiting is ambiguous and answers
 * none of them.
 *
 * The book of delivered cards (DeltaChat message id → question) is the
 * adapter's record of InteractiveQuestion.delivered_to / delivered_message_id.
 * It is persisted beside the DeltaChat account so a quoted reply still
 * resolves after a host restart. Whether a card is still waiting is asked of
 * the host (resolveQuestionRender), so a card answered or withdrawn elsewhere
 * stops matching.
 */
import fs from 'fs';

import { normalizeOptions, type NormalizedOption, type RawOption } from './ask-question.js';

/** Cards older than this are dropped from the book. */
const CARD_RETENTION_MS = 30 * 86_400_000;

export interface CardRecord {
  msgId: number;
  platformId: string;
  questionId: string;
  title: string;
  options: NormalizedOption[];
  /** When the asker stops waiting; null when the host decides (approvals). */
  expiresAt: string | null;
  createdAt: string;
}

export interface QuestionContent {
  questionId: string;
  title: string;
  question?: string;
  options: NormalizedOption[];
  sender?: string;
  expiresAt?: string;
}

/** The ask_question payload in an outbound chat-sdk message, or null. */
export function parseQuestionContent(content: Record<string, unknown>): QuestionContent | null {
  if (content.type !== 'ask_question' || typeof content.questionId !== 'string') return null;
  if (!Array.isArray(content.options) || content.options.length === 0) return null;
  return {
    questionId: content.questionId,
    title: typeof content.title === 'string' ? content.title : 'Question',
    question: typeof content.question === 'string' ? content.question : undefined,
    options: normalizeOptions(content.options as RawOption[]),
    sender: typeof content.sender === 'string' && content.sender ? content.sender : undefined,
    expiresAt: typeof content.expiresAt === 'string' ? content.expiresAt : undefined,
  };
}

export function renderQuestion(q: QuestionContent): string {
  const head = q.sender ? `❓ ${q.sender}: ${q.title}` : `❓ ${q.title}`;
  const lines = [head];
  if (q.question) lines.push(q.question);
  q.options.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
  lines.push('Reply with the number or the option.');
  return lines.join('\n');
}

/** Text for a send_card display card: title, description, text children, links. */
export function renderDisplayCard(content: Record<string, unknown>): string {
  const fallback = typeof content.fallbackText === 'string' ? content.fallbackText.trim() : '';
  if (fallback) return fallback;
  const card = (content.card ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof card.title === 'string' && card.title) lines.push(card.title);
  if (typeof card.description === 'string' && card.description) lines.push(card.description);
  for (const child of Array.isArray(card.children) ? card.children : []) {
    const text = typeof child === 'string' ? child : (child as { text?: unknown })?.text;
    if (typeof text === 'string' && text) lines.push(text);
  }
  for (const action of Array.isArray(card.actions) ? card.actions : []) {
    const a = action as { label?: unknown; url?: unknown };
    if (typeof a.label === 'string' && typeof a.url === 'string') lines.push(`${a.label}: ${a.url}`);
  }
  return lines.join('\n');
}

/** The text shown in place of a card once it is answered. */
export function renderAnswered(title: string, answer: string, question?: string): string {
  return [title, ...(question ? [question] : []), `→ ${answer}`].join('\n');
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The option a reply names: "<n>" (1-based) or a label, ignoring case and punctuation. */
export function optionNamedBy(options: NormalizedOption[], text: string): NormalizedOption | null {
  const t = norm(text);
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n >= 1 && n <= options.length ? options[n - 1] : null;
  }
  return options.find((o) => norm(o.label) === t || norm(o.value) === t) ?? null;
}

export class CardBook {
  private cards: CardRecord[] = [];

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CardRecord[];
      if (Array.isArray(parsed)) this.cards = parsed;
    } catch {
      // no book yet
    }
  }

  add(card: CardRecord, now = new Date()): void {
    this.cards = this.cards.filter(
      (c) => c.questionId !== card.questionId && now.getTime() - Date.parse(c.createdAt) < CARD_RETENTION_MS,
    );
    this.cards.push(card);
    this.save();
  }

  remove(questionId: string): void {
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => c.questionId !== questionId);
    if (this.cards.length !== before) this.save();
  }

  byMsgId(msgId: number): CardRecord | undefined {
    return this.cards.find((c) => c.msgId === msgId);
  }

  inChat(platformId: string): CardRecord[] {
    return this.cards.filter((c) => c.platformId === platformId);
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cards), 'utf-8');
    } catch {
      // best effort: an unsaved book only loses quote matching across a restart
    }
  }
}

export type ReplyMatch =
  | { kind: 'answer'; card: CardRecord; option: NormalizedOption }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * What a reply in `platformId` does. `isWaiting(questionId)` asks the host
 * whether the card's question is still unresolved.
 */
export async function matchReply(
  book: CardBook,
  platformId: string,
  text: string,
  quotedMsgId: number | null,
  isWaiting: (questionId: string) => Promise<boolean>,
  now = new Date(),
): Promise<ReplyMatch> {
  if (quotedMsgId !== null) {
    const card = book.byMsgId(quotedMsgId);
    if (!card || card.platformId !== platformId) return { kind: 'none' };
    // A quoted answer is delivered even after the asker stopped waiting,
    // as a late button click would be.
    if (!(await isWaiting(card.questionId))) return { kind: 'none' };
    const option = optionNamedBy(card.options, text);
    return option ? { kind: 'answer', card, option } : { kind: 'none' };
  }

  const open: CardRecord[] = [];
  for (const card of book.inChat(platformId)) {
    if (card.expiresAt && Date.parse(card.expiresAt) <= now.getTime()) continue;
    if (await isWaiting(card.questionId)) open.push(card);
  }
  const named = open.filter((c) => optionNamedBy(c.options, text));
  if (named.length === 0) return { kind: 'none' };
  if (open.length > 1) return { kind: 'ambiguous' };
  return { kind: 'answer', card: open[0], option: optionNamedBy(open[0].options, text)! };
}

export const AMBIGUOUS_REPLY_NOTICE =
  'Several questions are waiting for an answer here. Reply to (quote) the one you mean.';
