import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks (must come before imports that trigger side effects) ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  HOME_DIR: '/home/testuser',
  DATA_DIR: '/tmp/dc-test/data',
}));
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
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
import fs from 'fs';

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
    file: null,
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

    it('skips messages from the bot itself (fromId === 1)', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ fromId: 1 }));

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
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

  describe('/help command', () => {
    it('replies with command list in registered chat', async () => {
      const { dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/help' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: expect.stringContaining('/ping') }),
      );
    });

    it('replies with command list in unregistered chat', async () => {
      const { dc } = await buildConnectedChannel({ registered: false });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/help' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: expect.stringContaining('/chatid') }),
      );
    });

    it('does not route /help to onMessage', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/help' }));
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

  describe('progress reactions', () => {
    it('sends 👀 reaction on receipt from registered chat', async () => {
      const { dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, [
        '👀',
      ]);
    });

    it('does NOT send 👀 for unregistered chats', async () => {
      const { dc } = await buildConnectedChannel({ registered: false });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });

    it('sends 💭 reaction when setTyping(true) is called', async () => {
      const { channel, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      dc.rpc.sendReaction.mockClear();
      await channel.setTyping(JID, true);

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, [
        '💭',
      ]);
    });

    it('sends ✅ reaction when setTyping(false) is called', async () => {
      const { channel, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      dc.rpc.sendReaction.mockClear();
      await channel.setTyping(JID, false);

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, [
        '✅',
      ]);
    });

    it('setTyping does nothing when no message has been received', async () => {
      const { channel, dc } = await buildConnectedChannel({ registered: true });

      await channel.setTyping(JID, true);

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });

    it('tracks lastMsgId per JID independently', async () => {
      const CHAT_ID_2 = 99;
      const JID_2 = `dc:${CHAT_ID_2}`;
      const MSG_ID_2 = 200;
      const MSG_ID_1B = 150;

      const { channel, dc } = await buildConnectedChannel({
        registeredGroups: vi.fn(() => ({
          [JID]: {
            name: 'Group 1',
            folder: 'g1',
            trigger: '@Andy',
            added_at: '',
          },
          [JID_2]: {
            name: 'Group 2',
            folder: 'g2',
            trigger: '@Andy',
            added_at: '',
          },
        })),
      });

      // Message in chat 1
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hi' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg(CHAT_ID, MSG_ID);
      await flush();

      // Message in chat 2
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hey' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(
        makeChat({ name: 'Group 2' }),
      );
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg(CHAT_ID_2, MSG_ID_2);
      await flush();

      // Second message in chat 1
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'again' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg(CHAT_ID, MSG_ID_1B);
      await flush();

      dc.rpc.sendReaction.mockClear();

      await channel.setTyping(JID, false);
      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID_1B, [
        '✅',
      ]);

      dc.rpc.sendReaction.mockClear();

      await channel.setTyping(JID_2, false);
      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID_2, [
        '✅',
      ]);
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

  describe('attachment file handling', () => {
    it('copies image file to IPC attachments dir and includes container path in content', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          viewType: 'Image',
          text: '',
          file: '/dc/data/blobs/photo.jpg',
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(fs.copyFileSync).toHaveBeenCalledWith(
        '/dc/data/blobs/photo.jpg',
        expect.stringContaining(`${MSG_ID}-photo.jpg`),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({
          content: expect.stringContaining('/workspace/ipc/attachments/'),
        }),
      );
    });

    it('uses [Image] placeholder when file is null', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({ viewType: 'Image', text: '', file: null }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ content: '[Image]' }),
      );
      // Attachment file should NOT have been copied (only the avatar copy from connect() is allowed)
      const attachmentCopyCalls = (fs.copyFileSync as any).mock.calls.filter(
        ([src]: [string]) =>
          src === null || src === undefined || src.includes('dc/data/blobs'),
      );
      expect(attachmentCopyCalls).toHaveLength(0);
    });

    it('includes caption after the image container path', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          viewType: 'Image',
          text: 'Look!',
          file: '/dc/data/blobs/photo.jpg',
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const content: string = (opts.onMessage as any).mock.calls[0][1].content;
      expect(content).toMatch(
        /^\[Image: \/workspace\/ipc\/attachments\/\d+-photo\.jpg\]\nLook!$/,
      );
    });

    const fileTypes: [string, string, string, string][] = [
      ['Image', 'photo.jpg', '[Image', 'Image'],
      ['Gif', 'anim.gif', '[GIF', 'GIF'],
      ['Video', 'clip.mp4', '[Video', 'Video'],
      ['Sticker', 'sticker.webp', '[Sticker', 'Sticker'],
      ['Audio', 'track.ogg', '[Audio', 'Audio'],
      ['Voice', 'voice.ogg', '[Voice message', 'Voice'],
      ['Vcard', 'contact.vcf', '[Contact (vCard)', 'Vcard'],
      ['Webxdc', 'app.xdc', '[Webxdc app', 'Webxdc'],
    ];

    for (const [viewType, filename, labelPrefix, label] of fileTypes) {
      it(`includes container path for ${label} when file is present`, async () => {
        const { opts, dc } = await buildConnectedChannel({ registered: true });
        dc.rpc.getMessage.mockResolvedValueOnce(
          makeMsg({ viewType, text: '', file: `/dc/data/blobs/${filename}` }),
        );
        dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
        dc.rpc.getContact.mockResolvedValueOnce(makeContact());

        emitIncomingMsg();
        await flush();

        const content: string = (opts.onMessage as any).mock.calls[0][1]
          .content;
        expect(content).toContain('/workspace/ipc/attachments/');
        expect(content).toContain(labelPrefix);
      });
    }

    it('copies file attachments and uses container path as label', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          viewType: 'File',
          fileName: 'doc.pdf',
          text: '',
          file: '/dc/data/blobs/doc.pdf',
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const content: string = (opts.onMessage as any).mock.calls[0][1].content;
      expect(content).toMatch(
        /^\[File: \/workspace\/ipc\/attachments\/\d+-doc\.pdf\]$/,
      );
    });

    it('falls back to fileName for File type when file is null', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          viewType: 'File',
          fileName: 'report.xlsx',
          text: '',
          file: null,
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ content: '[File: report.xlsx]' }),
      );
    });
  });

  describe('quoted replies', () => {
    it('prepends WithMessage quote context to content', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          text: 'expand on that',
          quote: {
            kind: 'WithMessage',
            text: 'The sky is blue',
            authorDisplayName: 'Andy',
            messageId: 99,
          },
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({
          content: '[Replying to (Andy): "The sky is blue"]\nexpand on that',
        }),
      );
    });

    it('prepends WithMessage quote without author name when missing', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          text: 'yes exactly',
          quote: { kind: 'WithMessage', text: 'Some text', messageId: 88 },
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({
          content: '[Replying to: "Some text"]\nyes exactly',
        }),
      );
    });

    it('prepends JustText quote context to content', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          text: 'agreed',
          quote: { kind: 'JustText', text: 'Earlier text' },
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({
          content: '[Quoting: "Earlier text"]\nagreed',
        }),
      );
    });

    it('sends message with no quote prefix when quote is null', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({ text: 'plain message', quote: null }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ content: 'plain message' }),
      );
    });
  });

  describe('IncomingReaction', () => {
    function emitIncomingReaction(
      chatId = CHAT_ID,
      contactId = 5,
      msgId = MSG_ID,
      reaction = '👍',
    ) {
      emitterRef.current.emit('IncomingReaction', {
        chatId,
        contactId,
        msgId,
        reaction,
      });
    }

    it('routes reaction from registered chat to onMessage', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingReaction();
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({
          content: '[Reaction: 👍]',
          sender: 'alice@example.com',
          sender_name: 'Alice',
        }),
      );
    });

    it('ignores reaction from unregistered chat', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: false });
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingReaction();
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores empty reaction string', async () => {
      const { opts } = await buildConnectedChannel({ registered: true });

      emitIncomingReaction(CHAT_ID, 5, MSG_ID, '');
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses message id with contact id as unique event id', async () => {
      const { opts, dc } = await buildConnectedChannel({ registered: true });
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingReaction(CHAT_ID, 7, 200, '❤️');
      await flush();

      expect(opts.onMessage).toHaveBeenCalledWith(
        JID,
        expect.objectContaining({ id: 'reaction-200-7' }),
      );
    });
  });

  describe('sendFile', () => {
    it('sends a file with caption via DC RPC', async () => {
      const { channel, dc } = await buildConnectedChannel({ registered: true });

      await channel.sendFile(JID, '/host/path/result.jpg', 'Here you go');

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({
          file: '/host/path/result.jpg',
          text: 'Here you go',
        }),
      );
    });

    it('sends a file without caption (text is null)', async () => {
      const { channel, dc } = await buildConnectedChannel({ registered: true });

      await channel.sendFile(JID, '/host/path/image.png');

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({
          file: '/host/path/image.png',
          text: null,
        }),
      );
    });

    it('does nothing when not connected', async () => {
      const channel = new DeltaChatChannel(makeOpts());
      // Not connected — dc is null
      await channel.sendFile(JID, '/some/file.jpg');
      // No error thrown, dc.rpc.sendMsg not called (dc is null)
      expect(dcRef.current?.rpc.sendMsg).not.toHaveBeenCalled();
    });
  });
});
