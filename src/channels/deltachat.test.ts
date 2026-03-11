import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks (must come before imports that trigger side effects) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  HOME_DIR: '/home/testuser',
}));
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
  },
}));
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- DeltaChat RPC mock ---

type EventHandler = (...args: any[]) => any;

const dcRef = vi.hoisted(() => ({
  current: null as any,
}));

// Shared emitter so connect() handlers are reachable from tests
const emitterRef = vi.hoisted(() => ({
  current: null as any,
}));

vi.mock('@deltachat/stdio-rpc-server', () => ({
  startDeltaChat: vi.fn(async (_dataDir: string) => {
    // Build a fresh emitter for this connection
    const handlers = new Map<string, EventHandler[]>();
    const emitter = {
      on: (event: string, handler: EventHandler) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      emit: (event: string, ...args: any[]) => {
        for (const h of handlers.get(event) ?? []) h(...args);
      },
    };
    emitterRef.current = emitter;

    const dc = {
      rpc: {
        getAllAccounts: vi
          .fn()
          .mockResolvedValue([{ id: 1, kind: 'Configured' }]),
        addAccount: vi.fn().mockResolvedValue(2),
        batchSetConfig: vi.fn().mockResolvedValue(undefined),
        setConfigFromQr: vi.fn().mockResolvedValue(undefined),
        configure: vi.fn().mockResolvedValue(undefined),
        startIo: vi.fn().mockResolvedValue(undefined),
        stopIo: vi.fn().mockResolvedValue(undefined),
        getMessage: vi.fn(),
        getBasicChatInfo: vi.fn(),
        getContact: vi.fn(),
        sendMsg: vi.fn().mockResolvedValue(undefined),
        sendReaction: vi.fn().mockResolvedValue(undefined),
      },
      getContextEvents: vi.fn(() => emitter),
    };
    dcRef.current = dc;
    return dc;
  }),
}));

// Import the module under test AFTER mocks are set up
import { DeltaChatChannel } from './deltachat.js';
import type { DeltaChatChannelOpts } from './deltachat.js';
import type { RegisteredGroup } from '../types.js';

// --- Helpers ---

const CHAT_ID = 42;
const ACCOUNT_ID = 1;
const JID = `dc:${CHAT_ID}`;
const MSG_ID = 100;

function makeOpts(
  overrides?: Partial<DeltaChatChannelOpts> & {
    registered?: boolean;
  },
): DeltaChatChannelOpts {
  const registered = overrides?.registered ?? true;
  const registeredGroup: RegisteredGroup = {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
  };
  return {
    chatmailQr: undefined,
    addr: 'test@example.com',
    mailPw: 'secret',
    dataDir: '/tmp/dc-test',
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(
      () =>
        (registered ? { [JID]: registeredGroup } : {}) as Record<
          string,
          RegisteredGroup
        >,
    ),
    ...overrides,
  };
}

function makeMsg(overrides?: Partial<any>) {
  return {
    text: 'Hello',
    viewType: 'Text',
    fileName: null,
    isInfo: false,
    fromId: 5,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeChat(overrides?: Partial<any>) {
  return {
    name: 'Test Group',
    chatType: 1, // group (not 100)
    ...overrides,
  };
}

function makeContact(overrides?: Partial<any>) {
  return {
    address: 'alice@example.com',
    displayName: 'Alice',
    ...overrides,
  };
}

async function buildConnectedChannel(
  opts?: Partial<DeltaChatChannelOpts> & { registered?: boolean },
) {
  const channelOpts = makeOpts(opts);
  const channel = new DeltaChatChannel(channelOpts);
  await channel.connect();
  const dc = dcRef.current;
  return { channel, opts: channelOpts, dc };
}

function emitIncomingMsg(chatId = CHAT_ID, msgId = MSG_ID) {
  emitterRef.current.emit('IncomingMsg', { chatId, msgId });
}

// Give event handlers a chance to run
const flush = () => new Promise((r) => setTimeout(r, 10));

// --- Tests ---

describe('DeltaChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect / disconnect', () => {
    it('connects successfully with addr+mailPw', async () => {
      const { channel } = await buildConnectedChannel();
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects and marks not connected', async () => {
      const { channel } = await buildConnectedChannel();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('ownsJid returns true for dc: prefix', () => {
      const channel = new DeltaChatChannel(makeOpts());
      expect(channel.ownsJid('dc:123')).toBe(true);
      expect(channel.ownsJid('tg:123')).toBe(false);
    });
  });

  describe('unregistered chat filtering', () => {
    it('emits onChatMetadata for unregistered chats', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: false });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        JID,
        expect.any(String),
        'Test Group',
        'deltachat',
        true,
      );
    });

    it('does NOT emit onMessage for unregistered chats', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: false });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('emits onMessage for registered chats', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ content: 'Hello' }),
      );
    });

    it('skips info/system messages', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ isInfo: true }));

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });
  });

  describe('/ping command', () => {
    it('replies in registered chat', async () => {
      const { dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/ping' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: 'Andy is online.' }),
      );
    });

    it('replies in unregistered chat', async () => {
      const { dc } = await buildConnectedChannel({ registered: false });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/ping' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: 'Andy is online.' }),
      );
    });

    it('does not route /ping to onMessage', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/ping' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('/chatid command', () => {
    it('replies with JID and "registered" for registered chat', async () => {
      const { dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/chatid' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: `Chat ID: ${JID} (registered)` }),
      );
    });

    it('replies with JID and "not registered" for unregistered chat', async () => {
      const { dc } = await buildConnectedChannel({ registered: false });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/chatid' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: `Chat ID: ${JID} (not registered)` }),
      );
    });

    it('does not route /chatid to onMessage', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/chatid' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('non-text message placeholders', () => {
    const cases: [string, Partial<any>, string][] = [
      ['Image', { viewType: 'Image', text: '' }, '[Image]'],
      [
        'Image with caption',
        { viewType: 'Image', text: 'Nice pic' },
        '[Image]\nNice pic',
      ],
      ['GIF', { viewType: 'Gif', text: '' }, '[GIF]'],
      ['Sticker', { viewType: 'Sticker', text: '' }, '[Sticker]'],
      ['Audio', { viewType: 'Audio', text: '' }, '[Audio]'],
      ['Voice', { viewType: 'Voice', text: '' }, '[Voice message]'],
      ['Video', { viewType: 'Video', text: '' }, '[Video]'],
      [
        'File with name',
        { viewType: 'File', fileName: 'doc.pdf', text: '' },
        '[File: doc.pdf]',
      ],
      [
        'File without name',
        { viewType: 'File', fileName: null, text: '' },
        '[File]',
      ],
      [
        'VideochatInvitation',
        { viewType: 'VideochatInvitation', text: '' },
        '[Video chat invitation]',
      ],
      ['Call', { viewType: 'Call', text: '' }, '[Call]'],
      ['Webxdc', { viewType: 'Webxdc', text: '' }, '[Webxdc app]'],
      ['Vcard', { viewType: 'Vcard', text: '' }, '[Contact (vCard)]'],
      [
        'Unknown attachment',
        { viewType: 'SomeFutureType', text: '' },
        '[Attachment]',
      ],
    ];

    for (const [label, msgOverrides, expected] of cases) {
      it(`formats ${label} correctly`, async () => {
        const { opts, dc } = await buildConnectedChannel({ registered: true });
        dc.rpc.getMessage.mockResolvedValueOnce(makeMsg(msgOverrides));
        dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
        dc.rpc.getContact.mockResolvedValueOnce(makeContact());

        emitIncomingMsg();
        await flush();

        expect(opts.onMessage).toHaveBeenCalledWith(
          JID,
          expect.objectContaining({ content: expected }),
        );
      });
    }

    it('skips truly empty Text messages', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({ viewType: 'Text', text: '' }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });
});
