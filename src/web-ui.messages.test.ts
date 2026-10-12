/**
 * The Messages tab showed the oldest rows as raw JSON (2026-10-12). Rows are
 * now shaped like the chat the user saw. Row shapes are taken from a live
 * main-agent session.
 */
import { describe, expect, it } from 'vitest';

import { shapeInbound, shapeOutbound } from './web-ui.js';

const at = { id: 'm', timestamp: '2026-10-12T19:38:40.000Z' };
const inbound = (content: unknown, kind = 'chat', channel_type: string | null = 'deltachat') =>
  shapeInbound({ ...at, kind, channel_type, content: JSON.stringify(content) });
const outbound = (content: unknown, kind = 'chat', channel_type: string | null = 'deltachat') =>
  shapeOutbound({ ...at, kind, channel_type, content: JSON.stringify(content) });

describe('Messages tab shaping', () => {
  it('shows the user and the agent as chat bubbles', () => {
    expect(inbound({ text: 'Research X', sender: 'alanz', senderId: 'dc:fp:EC99' })).toMatchObject({
      type: 'bubble',
      role: 'user',
      sender: 'alanz',
      text: 'Research X',
    });
    expect(outbound({ text: 'The researcher is on it.' })).toMatchObject({ type: 'bubble', role: 'agent' });
  });

  it('drops host plumbing the user never saw', () => {
    expect(inbound({ type: 'memory_search_response', results: [] }, 'system', null)).toBeNull();
    expect(outbound({ text: '' })).toBeNull();
  });

  it('shows agent actions, reactions and edits as one-line events', () => {
    expect(outbound({ action: 'memory_search_request', query: 'Dependent Haskell' }, 'system', null)).toMatchObject({
      type: 'event',
      text: 'memory search request: Dependent Haskell',
    });
    expect(outbound({ operation: 'reaction', messageId: '1', emoji: '👍' })).toMatchObject({
      type: 'event',
      text: 'reacted 👍',
    });
    expect(outbound({ operation: 'edit', messageId: '1', text: 'x' })).toMatchObject({ type: 'event' });
    expect(
      inbound(
        { text: 'Specialist task dispatched (id: t). Result will…', sender: 'system', senderId: 'system' },
        'chat',
        null,
      ),
    ).toMatchObject({ type: 'event', text: 'specialist task dispatched' });
  });

  it('shows a specialist relay under the specialist name, unwrapped', () => {
    expect(
      inbound({
        text: '[Researcher told the user: Fetched the roadmap.]',
        sender: 'Researcher',
        senderId: 'specialist:x',
      }),
    ).toMatchObject({ role: 'specialist', sender: 'Researcher', text: 'Fetched the roadmap.' });
  });

  it('shows a question card with its options, and the answer as an event', () => {
    expect(
      outbound(
        {
          type: 'ask_question',
          questionId: 'q',
          title: 'Possible overlap',
          question: 'Proceed?',
          options: [{ label: 'Yes' }, 'No'],
        },
        'chat-sdk',
      ),
    ).toMatchObject({ role: 'agent', text: 'Possible overlap\nProceed?', options: ['Yes', 'No'] });
    expect(inbound({ type: 'question_response', selectedOption: 'Yes' }, 'system')).toMatchObject({
      type: 'event',
      text: 'answered: Yes',
    });
  });

  it('marks echoes from other sessions and specialist results', () => {
    expect(inbound({ text: 'Nightly scan…', sender: 'Andy' }, 'chat', 'session-echo')).toMatchObject({ role: 'echo' });
    expect(
      inbound(
        { text: 'report.md — summary', sender: 'system', senderId: 'system', completedSpecialistTaskId: 't' },
        'chat',
        null,
      ),
    ).toMatchObject({ role: 'system', sender: 'Specialist result' });
  });

  it('lists files sent either way', () => {
    expect(outbound({ text: '', files: ['paper.pdf'] })).toMatchObject({ role: 'agent', files: ['paper.pdf'] });
    expect(
      inbound({ text: '', sender: 'alanz', attachments: [{ name: 'a.pdf', localPath: 'inbox/1/a.pdf' }] }),
    ).toMatchObject({
      files: ['a.pdf'],
    });
  });
});
