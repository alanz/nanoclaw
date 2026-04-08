import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createContainerTransfer,
  createTask,
  createSpecialistTask,
  createSpecialistSession,
  createTransferFile,
  deleteTask,
  expireTransfersForTask,
  getAllChats,
  getAllRegisteredGroups,
  getContainerTransfer,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getSpecialistSession,
  getSpecialistSubTasks,
  getSpecialistTask,
  getSpecialistTasksByStatus,
  getTaskById,
  getTaskRunLogs,
  getTransferFilesByTransfer,
  logTaskRun,
  queryTranscript,
  setRegisteredGroup,
  setPendingDispatchDepthDb,
  storeChatMetadata,
  storeMessage,
  updateContainerTransfer,
  updateSpecialistSession,
  updateSpecialistTask,
  updateTask,
  updateTransferFile,
} from './db.js';
import { formatMessages } from './router.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });

  it('stores and retrieves dispatch_depth', () => {
    createTask({
      id: 'task-depth',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delegated task',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      dispatch_depth: 2,
    });

    const task = getTaskById('task-depth');
    expect(task).toBeDefined();
    expect(task!.dispatch_depth).toBe(2);
  });

  it('defaults dispatch_depth to 0 when not provided', () => {
    createTask({
      id: 'task-no-depth',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'normal task',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-no-depth');
    expect(task).toBeDefined();
    expect(task!.dispatch_depth ?? 0).toBe(0);
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- queryTranscript ---

describe('queryTranscript', () => {
  const JID = 'chat@g.us';
  const OTHER_JID = 'other@g.us';

  beforeEach(() => {
    storeChatMetadata(JID, '2026-01-01T09:59:00.000Z');
    storeChatMetadata(OTHER_JID, '2026-01-01T09:59:00.000Z');
    store({
      id: 'm1',
      chat_jid: JID,
      sender: 's1',
      sender_name: 'Alice',
      content: 'Hello',
      timestamp: '2026-01-01T10:00:00.000Z',
      is_from_me: false,
    });
    store({
      id: 'm2',
      chat_jid: JID,
      sender: 'bot',
      sender_name: 'Bot',
      content: 'Hi there',
      timestamp: '2026-01-01T10:01:00.000Z',
      is_from_me: true,
    });
    store({
      id: 'm3',
      chat_jid: JID,
      sender: 's1',
      sender_name: 'Alice',
      content: 'How are you?',
      timestamp: '2026-01-01T10:02:00.000Z',
      is_from_me: false,
    });
    store({
      id: 'm4',
      chat_jid: JID,
      sender: 'bot',
      sender_name: 'Bot',
      content: 'Great thanks!',
      timestamp: '2026-01-01T10:03:00.000Z',
      is_from_me: true,
    });
    store({
      id: 'o1',
      chat_jid: OTHER_JID,
      sender: 'x',
      sender_name: 'X',
      content: 'Other chat',
      timestamp: '2026-01-01T10:00:00.000Z',
      is_from_me: false,
    });
  });

  it('returns all messages for the given chatJid', () => {
    const result = queryTranscript({ chatJid: JID });
    expect(result.messages).toHaveLength(4);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it('does not return messages from other chats', () => {
    const result = queryTranscript({ chatJid: JID });
    expect(result.messages.every((m) => m.id !== 'o1')).toBe(true);
  });

  it('sets direction correctly', () => {
    const result = queryTranscript({ chatJid: JID });
    const [m1, m2, m3, m4] = result.messages;
    expect(m1.direction).toBe('inbound');
    expect(m2.direction).toBe('outbound');
    expect(m3.direction).toBe('inbound');
    expect(m4.direction).toBe('outbound');
  });

  it('includes sender and content', () => {
    const result = queryTranscript({ chatJid: JID });
    expect(result.messages[0].sender).toBe('Alice');
    expect(result.messages[0].content).toBe('Hello');
  });

  it('filters by from timestamp (inclusive)', () => {
    const result = queryTranscript({
      chatJid: JID,
      from: '2026-01-01T10:02:00.000Z',
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].id).toBe('m3');
  });

  it('filters by to timestamp (inclusive)', () => {
    const result = queryTranscript({
      chatJid: JID,
      to: '2026-01-01T10:01:00.000Z',
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].id).toBe('m2');
  });

  it('filters by from+to range', () => {
    const result = queryTranscript({
      chatJid: JID,
      from: '2026-01-01T10:01:00.000Z',
      to: '2026-01-01T10:02:00.000Z',
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('respects limit and sets has_more and next_cursor', () => {
    const result = queryTranscript({ chatJid: JID, limit: 2 });
    expect(result.messages).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).not.toBeNull();
  });

  it('paginates correctly using after_cursor', () => {
    const page1 = queryTranscript({ chatJid: JID, limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.has_more).toBe(true);

    const page2 = queryTranscript({
      chatJid: JID,
      limit: 2,
      afterCursor: page1.next_cursor!,
    });
    expect(page2.messages).toHaveLength(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();

    const allIds = [...page1.messages, ...page2.messages].map((m) => m.id);
    expect(allIds).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('returns empty messages for unknown chatJid', () => {
    const result = queryTranscript({ chatJid: 'unknown@g.us' });
    expect(result.messages).toHaveLength(0);
    expect(result.has_more).toBe(false);
  });

  it('clamps limit to 200 max', () => {
    const result = queryTranscript({ chatJid: JID, limit: 9999 });
    expect(result.messages).toHaveLength(4); // only 4 messages exist
  });

  it('excludes bot messages (is_bot_message=1) by default', () => {
    storeMessage({
      id: 'bot1',
      chat_jid: JID,
      sender: 'bot',
      sender_name: 'Bot',
      content: 'A bot reply',
      timestamp: '2026-01-01T10:04:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    const result = queryTranscript({ chatJid: JID });
    expect(result.messages.map((m) => m.id)).not.toContain('bot1');
  });

  it('includes bot messages when includeBotMessages=true', () => {
    storeMessage({
      id: 'bot2',
      chat_jid: JID,
      sender: 'bot',
      sender_name: 'Bot',
      content: 'Another bot reply',
      timestamp: '2026-01-01T10:05:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    const result = queryTranscript({ chatJid: JID, includeBotMessages: true });
    expect(result.messages.map((m) => m.id)).toContain('bot2');
  });
});

// --- logTaskRun / getTaskRunLogs ---

describe('logTaskRun', () => {
  beforeEach(() => {
    createTask({
      id: 'run-task',
      group_folder: 'main',
      chat_jid: 'dc:10',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('persists total_tokens when provided', () => {
    logTaskRun({
      task_id: 'run-task',
      run_at: '2026-01-01T00:00:01.000Z',
      duration_ms: 1500,
      status: 'success',
      result: 'done',
      error: null,
      total_tokens: 4200,
    });

    const logs = getTaskRunLogs('run-task');
    expect(logs).toHaveLength(1);
    expect(logs[0].total_tokens).toBe(4200);
  });

  it('stores null when total_tokens is omitted (backward compat)', () => {
    logTaskRun({
      task_id: 'run-task',
      run_at: '2026-01-01T00:00:01.000Z',
      duration_ms: 800,
      status: 'error',
      result: null,
      error: 'container exited with code 1',
    });

    const logs = getTaskRunLogs('run-task');
    expect(logs).toHaveLength(1);
    // SQLite returns null for missing column; cast to check falsy
    expect(logs[0].total_tokens ?? null).toBeNull();
  });

  it('returns runs newest-first', () => {
    logTaskRun({
      task_id: 'run-task',
      run_at: '2026-01-01T00:00:01.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'first',
      error: null,
      total_tokens: 100,
    });
    logTaskRun({
      task_id: 'run-task',
      run_at: '2026-01-01T00:00:02.000Z',
      duration_ms: 200,
      status: 'success',
      result: 'second',
      error: null,
      total_tokens: 200,
    });

    const logs = getTaskRunLogs('run-task');
    expect(logs).toHaveLength(2);
    expect(logs[0].result).toBe('second');
    expect(logs[0].total_tokens).toBe(200);
    expect(logs[1].total_tokens).toBe(100);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Specialist task accessors ---

function makeTask(
  overrides: Partial<Parameters<typeof createSpecialistTask>[0]> = {},
): Parameters<typeof createSpecialistTask>[0] {
  return {
    id: 'task-1',
    specialist_type: 'researcher',
    prompt: 'Find something',
    requester_group: 'main@g.us',
    requester_task_id: null,
    depth: 0,
    chain_delegation_count: 1,
    ancestor_types: '[]',
    is_last_same_type_dispatch: false,
    status: 'queued',
    pending_sub_task_id: null,
    result: null,
    failure_kind: null,
    failure_detail: null,
    restart_attempt_count: 0,
    delegated_at: '2024-01-01T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  };
}

describe('specialist tasks — createSpecialistTask / getSpecialistTask', () => {
  it('creates and retrieves a queued task', () => {
    createSpecialistTask(makeTask());
    const task = getSpecialistTask('task-1');
    expect(task).toBeDefined();
    expect(task!.id).toBe('task-1');
    expect(task!.specialist_type).toBe('researcher');
    expect(task!.status).toBe('queued');
    expect(task!.depth).toBe(0);
    expect(task!.chain_delegation_count).toBe(1);
    expect(task!.ancestor_types).toBe('[]');
    expect(task!.is_last_same_type_dispatch).toBe(0);
    expect(task!.requester_group).toBe('main@g.us');
    expect(task!.requester_task_id).toBeNull();
    expect(task!.result).toBeNull();
    expect(task!.failure_kind).toBeNull();
    expect(task!.failure_detail).toBeNull();
    expect(task!.closed_at).toBeNull();
    expect(task!.restart_attempt_count).toBe(0);
  });

  it('returns undefined for a non-existent task id', () => {
    expect(getSpecialistTask('no-such-task')).toBeUndefined();
  });

  it('stores is_last_same_type_dispatch as 1 when true', () => {
    createSpecialistTask(
      makeTask({ id: 'task-last', is_last_same_type_dispatch: true }),
    );
    const task = getSpecialistTask('task-last');
    expect(task!.is_last_same_type_dispatch).toBe(1);
  });

  it('stores a sub-task with requester_task_id and no requester_group', () => {
    createSpecialistTask(makeTask({ id: 'parent' }));
    createSpecialistTask(
      makeTask({
        id: 'child',
        requester_group: null,
        requester_task_id: 'parent',
        depth: 1,
        chain_delegation_count: 2,
        ancestor_types: '["researcher"]',
      }),
    );
    const child = getSpecialistTask('child');
    expect(child!.requester_task_id).toBe('parent');
    expect(child!.requester_group).toBeNull();
    expect(child!.depth).toBe(1);
    expect(child!.ancestor_types).toBe('["researcher"]');
  });
});

describe('specialist tasks — updateSpecialistTask', () => {
  it('transitions status from queued to running', () => {
    createSpecialistTask(makeTask());
    updateSpecialistTask('task-1', { status: 'running' });
    expect(getSpecialistTask('task-1')!.status).toBe('running');
  });

  it('sets result and status on completion', () => {
    createSpecialistTask(makeTask());
    updateSpecialistTask('task-1', {
      status: 'completed',
      result: 'Here is the answer',
      closed_at: '2024-01-01T01:00:00.000Z',
    });
    const task = getSpecialistTask('task-1')!;
    expect(task.status).toBe('completed');
    expect(task.result).toBe('Here is the answer');
    expect(task.closed_at).toBe('2024-01-01T01:00:00.000Z');
  });

  it('sets failure fields on failure', () => {
    createSpecialistTask(makeTask());
    updateSpecialistTask('task-1', {
      status: 'failed',
      failure_kind: 'timeout',
      failure_detail: 'Container invocation exceeded timeout',
      closed_at: '2024-01-01T02:00:00.000Z',
    });
    const task = getSpecialistTask('task-1')!;
    expect(task.status).toBe('failed');
    expect(task.failure_kind).toBe('timeout');
    expect(task.failure_detail).toBe('Container invocation exceeded timeout');
  });

  it('sets pending_sub_task_id when awaiting sub-task', () => {
    createSpecialistTask(makeTask({ id: 'parent' }));
    createSpecialistTask(
      makeTask({
        id: 'child',
        requester_group: null,
        requester_task_id: 'parent',
        depth: 1,
      }),
    );
    updateSpecialistTask('parent', {
      status: 'awaiting_sub_task',
      pending_sub_task_id: 'child',
    });
    const parent = getSpecialistTask('parent')!;
    expect(parent.status).toBe('awaiting_sub_task');
    expect(parent.pending_sub_task_id).toBe('child');
  });

  it('clears pending_sub_task_id when resuming', () => {
    createSpecialistTask(
      makeTask({
        id: 'parent',
        status: 'awaiting_sub_task',
        pending_sub_task_id: 'child',
      }),
    );
    updateSpecialistTask('parent', {
      status: 'running',
      pending_sub_task_id: null,
    });
    const parent = getSpecialistTask('parent')!;
    expect(parent.status).toBe('running');
    expect(parent.pending_sub_task_id).toBeNull();
  });

  it('increments restart_attempt_count', () => {
    createSpecialistTask(makeTask());
    updateSpecialistTask('task-1', { restart_attempt_count: 1 });
    expect(getSpecialistTask('task-1')!.restart_attempt_count).toBe(1);
  });

  it('is a no-op when called with empty updates', () => {
    createSpecialistTask(makeTask());
    updateSpecialistTask('task-1', {});
    expect(getSpecialistTask('task-1')!.status).toBe('queued');
  });
});

describe('specialist tasks — getSpecialistTasksByStatus', () => {
  it('returns tasks matching the given status', () => {
    createSpecialistTask(makeTask({ id: 't1', status: 'queued' }));
    createSpecialistTask(makeTask({ id: 't2', status: 'running' }));
    createSpecialistTask(makeTask({ id: 't3', status: 'queued' }));
    const queued = getSpecialistTasksByStatus('queued');
    expect(queued.map((t) => t.id).sort()).toEqual(['t1', 't3']);
  });

  it('returns an empty array when no tasks match', () => {
    createSpecialistTask(makeTask({ id: 't1', status: 'queued' }));
    expect(getSpecialistTasksByStatus('running')).toHaveLength(0);
  });
});

describe('specialist tasks — getSpecialistSubTasks', () => {
  it('returns sub-tasks for a given parent', () => {
    createSpecialistTask(makeTask({ id: 'parent' }));
    createSpecialistTask(
      makeTask({
        id: 'child1',
        requester_group: null,
        requester_task_id: 'parent',
        depth: 1,
      }),
    );
    createSpecialistTask(
      makeTask({
        id: 'child2',
        requester_group: null,
        requester_task_id: 'parent',
        depth: 1,
      }),
    );
    createSpecialistTask(makeTask({ id: 'unrelated' }));
    const subs = getSpecialistSubTasks('parent');
    expect(subs.map((t) => t.id).sort()).toEqual(['child1', 'child2']);
  });

  it('returns empty array when parent has no sub-tasks', () => {
    createSpecialistTask(makeTask());
    expect(getSpecialistSubTasks('task-1')).toHaveLength(0);
  });
});

// --- Specialist conversation session accessors ---

describe('specialist conversation sessions — createSpecialistSession / getSpecialistSession', () => {
  it('creates and retrieves a session', () => {
    createSpecialistTask(makeTask());
    createSpecialistSession({
      task_id: 'task-1',
      session_id: 'sess-abc',
      status: 'active',
    });
    const session = getSpecialistSession('task-1');
    expect(session).toBeDefined();
    expect(session!.task_id).toBe('task-1');
    expect(session!.session_id).toBe('sess-abc');
    expect(session!.status).toBe('active');
  });

  it('returns undefined for a task with no session', () => {
    createSpecialistTask(makeTask());
    expect(getSpecialistSession('task-1')).toBeUndefined();
  });
});

describe('specialist conversation sessions — updateSpecialistSession', () => {
  it('updates session_id', () => {
    createSpecialistTask(makeTask());
    createSpecialistSession({
      task_id: 'task-1',
      session_id: 'old-id',
      status: 'active',
    });
    updateSpecialistSession('task-1', { session_id: 'new-id' });
    expect(getSpecialistSession('task-1')!.session_id).toBe('new-id');
  });

  it('transitions status from active to stale', () => {
    createSpecialistTask(makeTask());
    createSpecialistSession({
      task_id: 'task-1',
      session_id: 'sess-abc',
      status: 'active',
    });
    updateSpecialistSession('task-1', { status: 'stale' });
    expect(getSpecialistSession('task-1')!.status).toBe('stale');
  });

  it('transitions status to cleared', () => {
    createSpecialistTask(makeTask());
    createSpecialistSession({
      task_id: 'task-1',
      session_id: 'sess-abc',
      status: 'active',
    });
    updateSpecialistSession('task-1', { status: 'cleared' });
    expect(getSpecialistSession('task-1')!.status).toBe('cleared');
  });

  it('is a no-op when called with empty updates', () => {
    createSpecialistTask(makeTask());
    createSpecialistSession({
      task_id: 'task-1',
      session_id: 'sess-abc',
      status: 'active',
    });
    updateSpecialistSession('task-1', {});
    expect(getSpecialistSession('task-1')!.session_id).toBe('sess-abc');
  });
});

describe('pending_dispatch_depth persistence', () => {
  const JID = 'group@g.us';
  const base = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@bot',
    added_at: '2024-01-01T00:00:00.000Z',
  };

  it('defaults to undefined when not set', () => {
    setRegisteredGroup(JID, base);
    const groups = getAllRegisteredGroups();
    expect(groups[JID]?.pendingDispatchDepth).toBeUndefined();
  });

  it('setRegisteredGroup persists pendingDispatchDepth', () => {
    setRegisteredGroup(JID, { ...base, pendingDispatchDepth: 3 });
    const groups = getAllRegisteredGroups();
    expect(groups[JID]?.pendingDispatchDepth).toBe(3);
  });

  it('setPendingDispatchDepthDb updates an existing group', () => {
    setRegisteredGroup(JID, base);
    setPendingDispatchDepthDb(JID, 5);
    const groups = getAllRegisteredGroups();
    expect(groups[JID]?.pendingDispatchDepth).toBe(5);
  });

  it('setPendingDispatchDepthDb clears depth when passed null', () => {
    setRegisteredGroup(JID, { ...base, pendingDispatchDepth: 7 });
    setPendingDispatchDepthDb(JID, null);
    const groups = getAllRegisteredGroups();
    expect(groups[JID]?.pendingDispatchDepth).toBeUndefined();
  });

  it('survives a simulated restart (re-read from DB)', () => {
    setRegisteredGroup(JID, base);
    setPendingDispatchDepthDb(JID, 2);
    // Re-read simulates what happens on process restart
    const groups = getAllRegisteredGroups();
    expect(groups[JID]?.pendingDispatchDepth).toBe(2);
  });
});

// --- container_transfers ---

function makeTransfer(overrides?: object) {
  return {
    id: 'xfer-1',
    sender_invocation_id: 'inv-abc',
    sender_group_folder: 'main',
    message: 'here are the files',
    file_count: 1,
    sent_at: '2024-01-01T00:00:00.000Z',
    status: 'pending' as const,
    recipient_task_id: null,
    recipient_group_folder: null,
    ...overrides,
  };
}

function makeTransferFile(overrides?: object) {
  return {
    id: 'file-1',
    transfer_id: 'xfer-1',
    original_name: 'report.md',
    host_path: '/data/transfers/xfer-1/report.md',
    status: 'owned' as const,
    ...overrides,
  };
}

describe('createContainerTransfer / getContainerTransfer', () => {
  it('stores and retrieves a transfer', () => {
    createContainerTransfer(makeTransfer());
    const t = getContainerTransfer('xfer-1');
    expect(t).toBeDefined();
    expect(t!.sender_invocation_id).toBe('inv-abc');
    expect(t!.status).toBe('pending');
    expect(t!.recipient_task_id).toBeNull();
  });

  it('returns undefined for unknown id', () => {
    expect(getContainerTransfer('nope')).toBeUndefined();
  });
});

describe('updateContainerTransfer', () => {
  it('updates status', () => {
    createContainerTransfer(makeTransfer());
    updateContainerTransfer('xfer-1', { status: 'in_transit' });
    expect(getContainerTransfer('xfer-1')!.status).toBe('in_transit');
  });

  it('sets recipient_task_id', () => {
    createContainerTransfer(makeTransfer());
    updateContainerTransfer('xfer-1', { recipient_task_id: 'task-99' });
    expect(getContainerTransfer('xfer-1')!.recipient_task_id).toBe('task-99');
  });

  it('clears recipient_task_id to null', () => {
    createContainerTransfer(makeTransfer({ recipient_task_id: 'task-99' }));
    updateContainerTransfer('xfer-1', { recipient_task_id: null });
    expect(getContainerTransfer('xfer-1')!.recipient_task_id).toBeNull();
  });

  it('is a no-op when called with empty updates', () => {
    createContainerTransfer(makeTransfer());
    updateContainerTransfer('xfer-1', {});
    expect(getContainerTransfer('xfer-1')!.status).toBe('pending');
  });
});

describe('createTransferFile / getTransferFilesByTransfer', () => {
  it('stores and retrieves files for a transfer', () => {
    createContainerTransfer(makeTransfer());
    createTransferFile(makeTransferFile());
    const files = getTransferFilesByTransfer('xfer-1');
    expect(files).toHaveLength(1);
    expect(files[0].original_name).toBe('report.md');
    expect(files[0].status).toBe('owned');
  });

  it('returns empty array when no files exist', () => {
    expect(getTransferFilesByTransfer('xfer-none')).toHaveLength(0);
  });

  it('returns multiple files for the same transfer', () => {
    createContainerTransfer(makeTransfer());
    createTransferFile(
      makeTransferFile({ id: 'file-1', original_name: 'a.md' }),
    );
    createTransferFile(
      makeTransferFile({ id: 'file-2', original_name: 'b.md' }),
    );
    expect(getTransferFilesByTransfer('xfer-1')).toHaveLength(2);
  });
});

describe('updateTransferFile', () => {
  it('updates status to placed', () => {
    createContainerTransfer(makeTransfer());
    createTransferFile(makeTransferFile());
    updateTransferFile('file-1', { status: 'placed' });
    expect(getTransferFilesByTransfer('xfer-1')[0].status).toBe('placed');
  });

  it('updates host_path', () => {
    createContainerTransfer(makeTransfer());
    createTransferFile(makeTransferFile());
    updateTransferFile('file-1', { host_path: '/new/path/report.md' });
    expect(getTransferFilesByTransfer('xfer-1')[0].host_path).toBe(
      '/new/path/report.md',
    );
  });
});

describe('expireTransfersForTask', () => {
  it('marks in_transit transfers and their files as expired', () => {
    createContainerTransfer(
      makeTransfer({ status: 'in_transit', recipient_task_id: 'task-1' }),
    );
    createTransferFile(makeTransferFile({ status: 'placed' }));

    expireTransfersForTask('task-1');

    expect(getContainerTransfer('xfer-1')!.status).toBe('expired');
    expect(getTransferFilesByTransfer('xfer-1')[0].status).toBe('expired');
  });

  it('ignores transfers with other statuses', () => {
    createContainerTransfer(
      makeTransfer({ status: 'pending', recipient_task_id: 'task-1' }),
    );
    expireTransfersForTask('task-1');
    expect(getContainerTransfer('xfer-1')!.status).toBe('pending');
  });

  it('ignores transfers for other tasks', () => {
    createContainerTransfer(
      makeTransfer({ status: 'in_transit', recipient_task_id: 'task-other' }),
    );
    expireTransfersForTask('task-1');
    expect(getContainerTransfer('xfer-1')!.status).toBe('in_transit');
  });

  it('is a no-op when no matching transfers exist', () => {
    expireTransfersForTask('task-nobody');
  });
});
