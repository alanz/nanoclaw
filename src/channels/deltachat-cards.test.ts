/**
 * Question cards answered by reply (specs/agent-to-agent.allium
 * QuestionAnsweredByReply, QuestionReplyAmbiguous).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { CardBook, matchReply, optionNamedBy, parseQuestionContent, type CardRecord } from './deltachat-cards.js';

const OPTIONS = [
  { label: 'Use existing', selectedLabel: 'Use existing', value: 'existing' },
  { label: 'New note', selectedLabel: 'New note', value: 'new' },
];
const NOW = new Date('2026-10-11T12:00:00.000Z');

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    msgId: 1,
    platformId: 'dc:42',
    questionId: 'q1',
    title: 'T',
    options: OPTIONS,
    expiresAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

const always = async () => true;

describe('optionNamedBy', () => {
  it('takes a 1-based number', () => {
    expect(optionNamedBy(OPTIONS, '2')?.value).toBe('new');
    expect(optionNamedBy(OPTIONS, ' 1. ')?.value).toBe('existing');
  });
  it('takes a label or value, ignoring case and punctuation', () => {
    expect(optionNamedBy(OPTIONS, 'new NOTE!')?.value).toBe('new');
    expect(optionNamedBy(OPTIONS, 'existing')?.value).toBe('existing');
  });
  it('rejects out-of-range numbers and other text', () => {
    expect(optionNamedBy(OPTIONS, '3')).toBeNull();
    expect(optionNamedBy(OPTIONS, '0')).toBeNull();
    expect(optionNamedBy(OPTIONS, 'use the existing one please')).toBeNull();
    expect(optionNamedBy(OPTIONS, '')).toBeNull();
  });
});

describe('parseQuestionContent', () => {
  it('normalizes bare-string options and keeps sender and expiry', () => {
    const q = parseQuestionContent({
      type: 'ask_question',
      questionId: 'q',
      title: 'T',
      options: ['Yes', 'No'],
      sender: 'Researcher',
      expiresAt: NOW.toISOString(),
    });
    expect(q?.options.map((o) => o.value)).toEqual(['Yes', 'No']);
    expect(q?.sender).toBe('Researcher');
    expect(q?.expiresAt).toBe(NOW.toISOString());
  });
  it('is null for anything that is not a question with options', () => {
    expect(parseQuestionContent({ type: 'card' })).toBeNull();
    expect(parseQuestionContent({ type: 'ask_question', questionId: 'q', options: [] })).toBeNull();
  });
});

describe('matchReply', () => {
  it('an unquoted answer resolves the only waiting card in the chat', async () => {
    const book = new CardBook(null);
    book.add(card(), NOW);
    book.add(card({ questionId: 'other-chat', platformId: 'dc:7', msgId: 2 }), NOW);
    const m = await matchReply(book, 'dc:42', '2', null, always, NOW);
    expect(m).toMatchObject({ kind: 'answer', card: { questionId: 'q1' }, option: { value: 'new' } });
  });

  it('unquoted with several waiting is ambiguous only when the text names an option', async () => {
    const book = new CardBook(null);
    book.add(card(), NOW);
    book.add(card({ questionId: 'q2', msgId: 2 }), NOW);
    expect((await matchReply(book, 'dc:42', '1', null, always, NOW)).kind).toBe('ambiguous');
    expect((await matchReply(book, 'dc:42', 'hello', null, always, NOW)).kind).toBe('none');
  });

  it('cards that are no longer waiting, or expired, do not count as open', async () => {
    const book = new CardBook(null);
    book.add(card(), NOW);
    book.add(card({ questionId: 'gone', msgId: 2 }), NOW);
    book.add(card({ questionId: 'expired', msgId: 3, expiresAt: '2026-10-11T11:00:00.000Z' }), NOW);
    const m = await matchReply(book, 'dc:42', '1', null, async (id) => id !== 'gone', NOW);
    expect(m).toMatchObject({ kind: 'answer', card: { questionId: 'q1' } });
  });

  it('a quoted answer picks its card, expired or not, but never one from another chat', async () => {
    const book = new CardBook(null);
    book.add(card({ expiresAt: '2026-10-11T11:00:00.000Z' }), NOW);
    book.add(card({ questionId: 'q2', msgId: 2 }), NOW);
    expect(await matchReply(book, 'dc:42', '1', 1, always, NOW)).toMatchObject({ kind: 'answer', card: { msgId: 1 } });
    expect((await matchReply(book, 'dc:7', '1', 1, always, NOW)).kind).toBe('none');
    expect((await matchReply(book, 'dc:42', '1', 99, always, NOW)).kind).toBe('none');
  });
});

describe('CardBook', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('survives a restart, and forgets removed and old cards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cards-'));
    dirs.push(dir);
    const file = path.join(dir, 'cards.json');
    const book = new CardBook(file);
    book.add(card({ createdAt: '2026-08-01T00:00:00.000Z', questionId: 'old', msgId: 9 }), NOW);
    book.add(card(), NOW); // prunes the 70-day-old card
    book.add(card({ questionId: 'q2', msgId: 2 }), NOW);
    book.remove('q2');

    const reloaded = new CardBook(file);
    expect(reloaded.byMsgId(1)?.questionId).toBe('q1');
    expect(reloaded.byMsgId(2)).toBeUndefined();
    expect(reloaded.byMsgId(9)).toBeUndefined();
  });
});
