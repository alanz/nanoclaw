/**
 * The host's hand-over of the previous conversation's summary (session reset
 * module): a session-echo row on the 'conversation-handover' surface. It is
 * first-class context the new conversation continues from, so it renders as
 * its own <previous-conversation> block, not as an ambient echo, and like
 * every echo it never routes a reply or wakes the agent by itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { extractRouting, formatMessages } from './formatter.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertHandover(text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, "trigger", channel_type, thread_id, content)
       VALUES ('h1', 2, 'chat', ?, 'pending', 0, 'session-echo', NULL, ?)`,
    )
    .run(
      new Date().toISOString(),
      JSON.stringify({
        text,
        sender: 'NanoClaw',
        echo: { surface: 'conversation-handover', label: 'the previous conversation' },
      }),
    );
}

describe('conversation hand-over rendering', () => {
  it('renders as a previous-conversation block, escaped', () => {
    insertHandover('## Summary\nTalked about <types> & roadmaps.');
    const out = formatMessages(getPendingMessages());
    expect(out).toContain(
      '<previous-conversation>## Summary\nTalked about &lt;types&gt; &amp; roadmaps.</previous-conversation>',
    );
    expect(out).not.toContain('<cross-session-context');
  });

  it('rides along with the next message, which keeps the reply routing', () => {
    insertHandover('## Summary\nx');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, "trigger", platform_id, channel_type, thread_id, content)
         VALUES ('m1', 4, 'chat', ?, 'pending', 1, 'dc:10', 'deltachat', NULL, ?)`,
      )
      .run(new Date().toISOString(), JSON.stringify({ sender: 'Alan', text: 'carry on' }));

    const messages = getPendingMessages();
    expect(messages.map((m) => m.id)).toEqual(['h1', 'm1']);
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('dc:10');
    expect(routing.channelType).toBe('deltachat');
    const out = formatMessages(messages);
    expect(out.indexOf('<previous-conversation>')).toBeLessThan(out.indexOf('carry on'));
  });
});
