import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks (must precede imports that trigger side effects) ---

vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
const completedHooks = vi.hoisted(() => [] as Array<(completed: unknown[], session: unknown) => Promise<void>>);
vi.mock('../reconcile-session.js', () => ({
  registerInboundCompletedHook: (hook: (completed: unknown[], session: unknown) => Promise<void>) => {
    completedHooks.push(hook);
    return () => completedHooks.splice(completedHooks.indexOf(hook), 1);
  },
}));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/dc-test/data',
}));
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 100 })),
    readFileSync: vi.fn(() => Buffer.from('fake-image-data')),
    mkdtempSync: vi.fn(() => '/tmp/dc-out-abc'),
    rmSync: vi.fn(),
  },
}));
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/testuser'),
    tmpdir: vi.fn(() => '/tmp'),
  },
}));
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (process.env[key] !== undefined) result[key] = process.env[key]!;
    }
    return result;
  }),
}));

vi.mock('../modules/permissions/db/users.js', () => ({
  mergeUsersInto: vi.fn().mockResolvedValue([]),
}));

// The app archive is built from real files (deltachat-webxdc.test.ts covers it).
vi.mock('./deltachat-webxdc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deltachat-webxdc.js')>()),
  buildXdc: vi.fn(() => Buffer.from('xdc')),
}));

// Question liveness: by default every card's question is still waiting.
const waiting = vi.hoisted(() => ({ ids: null as Set<string> | null }));
vi.mock('./question-render-registry.js', () => ({
  resolveQuestionRender: vi.fn(async (id: string) =>
    waiting.ids === null || waiting.ids.has(id) ? { title: 'T', options: [] } : undefined,
  ),
}));

// --- DeltaChat RPC mock ---

type EventHandler = (...args: unknown[]) => unknown;

const dcRef = vi.hoisted(() => ({ current: null as ReturnType<typeof makeDcMock> | null }));
const emitterRef = vi.hoisted(() => ({ current: null as ReturnType<typeof makeEmitter> | null }));

function makeEmitter() {
  const handlers = new Map<string, EventHandler[]>();
  return {
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
}

function makeDcMock() {
  return {
    rpc: {
      getAllAccounts: vi.fn().mockResolvedValue([{ id: 1, kind: 'Configured' }]),
      addAccount: vi.fn().mockResolvedValue(2),
      batchSetConfig: vi.fn().mockResolvedValue(undefined),
      setConfigFromQr: vi.fn().mockResolvedValue(undefined),
      configure: vi.fn().mockResolvedValue(undefined),
      startIo: vi.fn().mockResolvedValue(undefined),
      stopIo: vi.fn().mockResolvedValue(undefined),
      getMessage: vi.fn(),
      getBasicChatInfo: vi.fn(),
      getContact: vi.fn(),
      sendMsg: vi.fn().mockResolvedValue(42),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      sendEditRequest: vi.fn().mockResolvedValue(null),
      deleteMessagesForAll: vi.fn().mockResolvedValue(null),
      getConnectivity: vi.fn().mockResolvedValue(4000),
      getConfig: vi.fn().mockResolvedValue('bot@example.com'),
      getChatSecurejoinQrCode: vi.fn().mockResolvedValue('https://i.delta.chat/#MOCKINVITE'),
      getContactEncryptionInfo: vi.fn(),
      getContactIds: vi.fn().mockResolvedValue([]),
      lookupContactIdByAddr: vi.fn().mockResolvedValue(null),
      createChatByContactId: vi.fn().mockResolvedValue(77),
      sendWebxdcStatusUpdate: vi.fn().mockResolvedValue(undefined),
      getWebxdcStatusUpdates: vi.fn().mockResolvedValue('[]'),
      getChatContacts: vi.fn().mockResolvedValue([5]),
    },
    getContextEvents: vi.fn(() => emitterRef.current!),
  };
}

vi.mock('@deltachat/stdio-rpc-server', () => ({
  startDeltaChat: vi.fn((_dataDir: string) => {
    const emitter = makeEmitter();
    emitterRef.current = emitter;
    const dc = makeDcMock();
    dc.getContextEvents = vi.fn(() => emitter);
    dcRef.current = dc;
    return dc;
  }),
}));

// Import AFTER mocks (vi.mock() calls above are hoisted before these by vitest)
import './deltachat.js'; // triggers registerChannelAdapter side effect
import type { ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { mergeUsersInto } from '../modules/permissions/db/users.js';
import fs from 'fs';

// Capture the registered factory once, before beforeEach clears mock call history.
type DcRegistration = Parameters<typeof registerChannelAdapter>[1];
let capturedRegistration: DcRegistration | undefined;

// --- Constants ---

const CHAT_ID = 42;
const ACCOUNT_ID = 1;
const PLATFORM_ID = `dc:${CHAT_ID}`;
const MSG_ID = 100;

// --- Helpers ---

function makeSetup() {
  const received: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
  const metadata: Array<{ platformId: string; name?: string; isGroup?: boolean }> = [];
  const config: ChannelSetup = {
    onInbound: vi.fn((platformId, threadId, message) => {
      received.push({ platformId, threadId, message });
    }),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn((platformId, name, isGroup) => {
      metadata.push({ platformId, name, isGroup });
    }),
    onAction: vi.fn(),
  };
  return { config, received, metadata };
}

function makeMsg(overrides?: Record<string, unknown>) {
  return {
    text: 'Hello',
    viewType: 'Text',
    fileName: null,
    file: null,
    isInfo: false,
    fromId: 5,
    timestamp: Math.floor(Date.now() / 1000),
    quote: null,
    systemMessageType: null,
    ...overrides,
  };
}

function makeChat(overrides?: Record<string, unknown>) {
  return {
    name: 'Test Chat',
    chatType: 'Group',
    ...overrides,
  };
}

function makeContact(overrides?: Record<string, unknown>) {
  return {
    address: 'alice@example.com',
    displayName: 'Alice',
    ...overrides,
  };
}

/** Get the registered factory from the mock and build + connect an adapter. */
async function buildSetupAdapter(envOverrides?: Record<string, string | undefined>) {
  const env = {
    DELTACHAT_ADDR: 'test@example.com',
    DELTACHAT_MAIL_PW: 'secret',
    DELTACHAT_CHATMAIL_QR: undefined,
    DELTACHAT_DATA_DIR: undefined,
    ...envOverrides,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }

  if (!capturedRegistration) throw new Error('registerChannelAdapter was never called');
  const adapter = await capturedRegistration.factory();
  if (!adapter) throw new Error('factory returned null');

  const { config, received, metadata } = makeSetup();
  await adapter.setup(config);

  const dc = dcRef.current!;
  return { adapter, config, received, metadata, dc };
}

function emitIncomingMsg(chatId = CHAT_ID, msgId = MSG_ID) {
  emitterRef.current!.emit('IncomingMsg', { chatId, msgId });
}

/** Settle async handlers, then advance past the 1500ms debounce. */
const flush = async () => {
  await new Promise<void>((r) => setTimeout(r, 10));
  vi.advanceTimersByTime(1500);
  await new Promise<void>((r) => setTimeout(r, 10));
};

/** Settle async handlers without firing the debounce. */
const settle = () => new Promise<void>((r) => setTimeout(r, 10));

// --- Tests ---

describe('DeltaChat channel adapter', () => {
  beforeAll(() => {
    // The module side effect runs once at import time. Capture the registration
    // here, before beforeEach clears mock call history.
    const calls = vi.mocked(registerChannelAdapter).mock.calls;
    const last = calls[calls.length - 1];
    if (!last) throw new Error('deltachat.js did not call registerChannelAdapter during import');
    capturedRegistration = last[1];
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DELTACHAT_ADDR;
    delete process.env.DELTACHAT_MAIL_PW;
    delete process.env.DELTACHAT_CHATMAIL_QR;
    delete process.env.DELTACHAT_DATA_DIR;
  });

  describe('factory', () => {
    it('returns an adapter with the default chatmail QR when no credentials set', async () => {
      delete process.env.DELTACHAT_ADDR;
      delete process.env.DELTACHAT_MAIL_PW;
      delete process.env.DELTACHAT_CHATMAIL_QR;

      if (!capturedRegistration) throw new Error('registerChannelAdapter was never called');
      const adapter = await capturedRegistration.factory();
      expect(adapter).not.toBeNull();
      expect(adapter?.name).toBe('deltachat');
    });
  });

  describe('setup / teardown / isConnected', () => {
    it('setup connects successfully with addr+mailPw', async () => {
      const { adapter } = await buildSetupAdapter();
      expect(adapter.isConnected()).toBe(true);
    });

    it('teardown marks adapter as not connected', async () => {
      const { adapter } = await buildSetupAdapter();
      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('teardown calls stopIo', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      await adapter.teardown();
      expect(dc.rpc.stopIo).toHaveBeenCalledWith(ACCOUNT_ID);
    });

    it('sets avatar at startup when file exists', async () => {
      await buildSetupAdapter();
      expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('nanoclaw-profile.jpeg'),
        expect.any(String),
      );
    });

    it('does not crash when avatar file is missing', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      // Subsequent calls (accounts.toml check) should still return true
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const { adapter } = await buildSetupAdapter();
      expect(adapter.isConnected()).toBe(true);
    });

    it('creates accounts.toml when it does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      await buildSetupAdapter();
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('accounts.toml'),
        expect.any(String),
        'utf8',
      );
    });

    it('configures account via chatmailQr when provided', async () => {
      // Use a fresh registration — reset mock count
      vi.mocked(registerChannelAdapter).mockClear();

      // Re-import to trigger a fresh registerChannelAdapter call
      await import('./deltachat.js');

      const calls = vi.mocked(registerChannelAdapter).mock.calls;
      const last = calls[calls.length - 1];
      if (!last) return;
      const [, registration] = last;

      // Configure with QR
      const dc = dcRef.current ? { ...dcRef.current } : null;
      const accounts = [{ id: 1, kind: 'Unconfigured' }];
      const freshDc = makeDcMock();
      freshDc.rpc.getAllAccounts = vi.fn().mockResolvedValue(accounts);
      dcRef.current = freshDc;

      process.env.DELTACHAT_CHATMAIL_QR = 'dcaccount:https://example.com/new';
      delete process.env.DELTACHAT_ADDR;
      delete process.env.DELTACHAT_MAIL_PW;

      const adapter = await registration.factory();
      if (!adapter) return;
      const { config } = makeSetup();
      await adapter.setup(config);

      expect(freshDc.rpc.setConfigFromQr).toHaveBeenCalled();
      if (dc) dcRef.current = dc as ReturnType<typeof makeDcMock>;
    });
  });

  describe('IncomingMsg filtering', () => {
    it('skips bot own messages (fromId === 1)', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ fromId: 1 }));

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
      expect(vi.mocked(config.onMetadata)).not.toHaveBeenCalled();
    });

    it('skips info messages', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ isInfo: true }));

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });

    it('skips AutocryptSetupMessage', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ systemMessageType: 'AutocryptSetupMessage' }));

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });

    it('routes normal message via onInbound', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hello' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).toHaveBeenCalledOnce();
      const [pid, tid, msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect(pid).toBe(PLATFORM_ID);
      expect(tid).toBeNull();
      expect((msg.content as Record<string, unknown>).text).toBe('hello');
    });

    it('reports onMetadata for each incoming message', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat({ name: 'My Chat', chatType: 'Group' }));
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onMetadata)).toHaveBeenCalledWith(PLATFORM_ID, 'My Chat', true);
    });

    it('reports isGroup=false for Single chat type', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onMetadata)).toHaveBeenCalledWith(PLATFORM_ID, expect.any(String), false);
    });
  });

  describe('/ping command', () => {
    it('replies with online message', async () => {
      const { dc } = await buildSetupAdapter();
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

    it('does not route /ping to onInbound', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/ping' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });
  });

  describe('/chatid command', () => {
    it('replies with the platform ID', async () => {
      const { dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/chatid' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: `Chat ID: ${PLATFORM_ID}` }),
      );
    });

    it('does not route /chatid to onInbound', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/chatid' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });
  });

  describe('receipt reactions', () => {
    it('sends 👀 on receipt of a routed message', async () => {
      const { dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, ['👀']);
    });

    it('does not send 👀 for /ping command (not routed)', async () => {
      const { dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: '/ping' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });
  });

  describe('setTyping', () => {
    it('sends 💭 on the last incoming message', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      dc.rpc.sendReaction.mockClear();
      await adapter.setTyping!(PLATFORM_ID, null);

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, ['💭']);
    });

    it('sends 💭 once however often the typing refresh fires', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();

      dc.rpc.sendReaction.mockClear();
      await adapter.setTyping!(PLATFORM_ID, null);
      await adapter.setTyping!(PLATFORM_ID, null);
      await adapter.setTyping!(PLATFORM_ID, null);

      expect(dc.rpc.sendReaction).toHaveBeenCalledTimes(1);
      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, ['💭']);
    });

    it('sends each status step in a later second than the one before, however fast the reply', async () => {
      // Whole-second reaction timestamps: two steps in one second can show in
      // either order, which left 💭 over ✅ after a sub-second "Session cleared.".
      vi.setSystemTime(new Date('2026-10-14T19:47:07.100Z'));
      const { adapter, dc } = await buildSetupAdapter();
      const sentAt: Array<[string, number]> = [];
      dc.rpc.sendReaction.mockImplementation(async (_a: number, _m: number, [emoji]: string[]) => {
        sentAt.push([emoji, Date.now()]);
      });
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();

      const typing = adapter.setTyping!(PLATFORM_ID, null);
      const reply = adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'Session cleared.' } });
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all([typing, reply]);

      expect(sentAt.map(([emoji]) => emoji)).toEqual(['👀', '💭', '✅']);
      const seconds = sentAt.map(([, t]) => Math.floor(t / 1000));
      expect(seconds[1]).toBeGreaterThan(seconds[0]);
      expect(seconds[2]).toBeGreaterThan(seconds[1]);
    });

    it('does not put 💭 back over ✅ once a reply is delivered', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();

      await adapter.setTyping!(PLATFORM_ID, null);
      await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'Part one' } });
      dc.rpc.sendReaction.mockClear();
      await adapter.setTyping!(PLATFORM_ID, null);
      await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'Part two' } });

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });

    it('leaves a reaction the agent chose on the message', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { operation: 'reaction', messageId: String(MSG_ID), emoji: '👍' },
      });
      dc.rpc.sendReaction.mockClear();
      await adapter.setTyping!(PLATFORM_ID, null);
      await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'Done' } });

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });

    it('starts again from 👀 on the next incoming message', async () => {
      const MSG_ID_2 = 150;
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();
      await adapter.setTyping!(PLATFORM_ID, null);
      await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'Reply' } });

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'next' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg(CHAT_ID, MSG_ID_2);
      await flush();
      dc.rpc.sendReaction.mockClear();
      await adapter.setTyping!(PLATFORM_ID, null);

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID_2, ['💭']);
    });

    it('does nothing when no message has been received yet', async () => {
      const { adapter, dc } = await buildSetupAdapter();

      await adapter.setTyping!(PLATFORM_ID, null);

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });

    it('tracks lastMsgId per platformId independently', async () => {
      const CHAT_ID_2 = 99;
      const PID_2 = `dc:${CHAT_ID_2}`;
      const MSG_ID_2 = 200;
      const MSG_ID_1B = 150;

      const { adapter, dc } = await buildSetupAdapter();

      // Message in chat 1
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hi' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg(CHAT_ID, MSG_ID);
      await flush();

      // Message in chat 2
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hey' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
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

      await adapter.setTyping!(PLATFORM_ID, null);
      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID_1B, ['💭']);

      dc.rpc.sendReaction.mockClear();

      await adapter.setTyping!(PID_2, null);
      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID_2, ['💭']);
    });
  });

  describe('progress message', () => {
    const PROGRESS_ID = 42; // sendMsg mock's id
    const sentTexts = (dc: { rpc: { sendMsg: { mock: { calls: unknown[][] } } } }) =>
      dc.rpc.sendMsg.mock.calls.map((c) => (c[2] as { text: string }).text);

    async function turnStarted() {
      const built = await buildSetupAdapter();
      built.dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      built.dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      built.dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();
      await built.adapter.setTyping!(PLATFORM_ID, null, 'thinking');
      return built;
    }

    it('appears with the first status, then follows it at most every 10 s', async () => {
      const { adapter, dc } = await turnStarted();
      expect(sentTexts(dc)).toEqual(['⏳ Thinking…']);
      vi.setSystemTime(Date.now() + 10_000);
      await adapter.setTyping!(PLATFORM_ID, null, 'searching the web');
      expect(dc.rpc.sendEditRequest).toHaveBeenCalledWith(ACCOUNT_ID, PROGRESS_ID, '⏳ Searching the web…');
      vi.mocked(dc.rpc.sendEditRequest).mockClear();

      vi.setSystemTime(Date.now() + 4_000);
      await adapter.setTyping!(PLATFORM_ID, null, 'reading a web page');
      expect(dc.rpc.sendEditRequest).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 8_000);
      await adapter.setTyping!(PLATFORM_ID, null, 'reading a web page');
      expect(dc.rpc.sendEditRequest).toHaveBeenCalledWith(ACCOUNT_ID, PROGRESS_ID, '⏳ Reading a web page…');
      expect(dc.rpc.sendMsg).toHaveBeenCalledTimes(1);
    });

    it('is deleted for everyone when the reply arrives', async () => {
      const { adapter, dc } = await turnStarted();
      await adapter.setTyping!(PLATFORM_ID, null, 'thinking');
      await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'Answer' } });

      expect(dc.rpc.deleteMessagesForAll).toHaveBeenCalledWith(ACCOUNT_ID, [PROGRESS_ID]);
      expect(sentTexts(dc)).toEqual(['⏳ Thinking…', 'Answer']);
    });

    it('stays while a specialist relays under its own name', async () => {
      const { adapter, dc } = await turnStarted();
      await adapter.setTyping!(PLATFORM_ID, null, 'waiting on a specialist');
      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { text: 'Found three papers', sender: 'Researcher' },
      });

      expect(dc.rpc.deleteMessagesForAll).not.toHaveBeenCalled();
    });

    it('is deleted when the turn ends without a reply', async () => {
      const { adapter, dc } = await turnStarted();
      await adapter.setTyping!(PLATFORM_ID, null, 'thinking');

      await completedHooks.at(-1)!(
        [{ id: `${MSG_ID}:ag-test`, kind: 'chat', platformId: PLATFORM_ID, channelType: 'deltachat', threadId: null }],
        { agent_group_id: 'ag-test' },
      );

      expect(dc.rpc.deleteMessagesForAll).toHaveBeenCalledWith(ACCOUNT_ID, [PROGRESS_ID]);
    });
  });

  describe('turn completed without a reply', () => {
    const AG = 'ag-test';
    const completedOn = (msgId: number) => [
      { id: `${msgId}:${AG}`, kind: 'chat', platformId: PLATFORM_ID, channelType: 'deltachat', threadId: null },
    ];

    it('sets ✅ on the last incoming message when its turn completes', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();
      await adapter.setTyping!(PLATFORM_ID, null);
      dc.rpc.sendReaction.mockClear();

      await completedHooks.at(-1)!(completedOn(MSG_ID), { agent_group_id: AG });

      expect(dc.rpc.sendReaction).toHaveBeenCalledTimes(1);
      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, ['✅']);
    });

    it('leaves a newer message alone when an older turn completes', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();
      await adapter.setTyping!(PLATFORM_ID, null);
      dc.rpc.sendReaction.mockClear();

      await completedHooks.at(-1)!(completedOn(MSG_ID - 1), { agent_group_id: AG });

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });

    it('does not resend ✅ after the reply already set it', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();
      await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'Reply' } });
      dc.rpc.sendReaction.mockClear();

      await completedHooks.at(-1)!(completedOn(MSG_ID), { agent_group_id: AG });

      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });
  });

  describe('debouncing', () => {
    it('does not deliver before the debounce window expires', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hello' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await settle();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });

    it('delivers a single message after the debounce window', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hello' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).toHaveBeenCalledOnce();
      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).text).toBe('hello');
    });

    it('combines rapid messages from the same chat into one delivery', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'first' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'second' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg(CHAT_ID, 101);
      await settle();
      emitIncomingMsg(CHAT_ID, 102);
      await settle();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1500);
      await settle();

      expect(vi.mocked(config.onInbound)).toHaveBeenCalledOnce();
      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).text).toBe('first\nsecond');
      expect(msg.id).toBe('102');
    });

    it('uses the last msgId as the delivery id', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'a' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'b' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg(CHAT_ID, 201);
      await settle();
      emitIncomingMsg(CHAT_ID, 202);
      await settle();
      vi.advanceTimersByTime(1500);
      await settle();

      expect(vi.mocked(config.onInbound)).toHaveBeenCalledWith(
        PLATFORM_ID,
        null,
        expect.objectContaining({ id: '202' }),
      );
    });

    it('keeps debounce timers per platformId independent', async () => {
      const CHAT_ID_2 = 99;
      const PID_2 = `dc:${CHAT_ID_2}`;
      const { config, dc } = await buildSetupAdapter();

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'jid1' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'jid2' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg(CHAT_ID, 301);
      emitIncomingMsg(CHAT_ID_2, 302);
      await settle();
      vi.advanceTimersByTime(1500);
      await settle();

      expect(vi.mocked(config.onInbound)).toHaveBeenCalledTimes(2);
      const pids = vi.mocked(config.onInbound).mock.calls.map(([pid]) => pid);
      expect(pids).toContain(PLATFORM_ID);
      expect(pids).toContain(PID_2);
    });
  });

  describe('quoted replies', () => {
    it('prepends WithMessage quote context', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          text: 'expand on that',
          quote: { kind: 'WithMessage', text: 'The sky is blue', authorDisplayName: 'Andy' },
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      const text = (msg.content as Record<string, unknown>).text as string;
      expect(text).toBe('[Replying to (Andy): "The sky is blue"]\nexpand on that');
    });

    it('prepends WithMessage quote without author when missing', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(
        makeMsg({
          text: 'yes',
          quote: { kind: 'WithMessage', text: 'Some text' },
        }),
      );
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).text).toBe('[Replying to: "Some text"]\nyes');
    });

    it('prepends JustText quote context', async () => {
      const { config, dc } = await buildSetupAdapter();
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

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).text).toBe('[Quoting: "Earlier text"]\nagreed');
    });
  });

  describe('media placeholders', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['Image (no file)', { viewType: 'Image', text: '', file: null }, '[Image]'],
      ['Image with caption', { viewType: 'Image', text: 'Nice pic', file: null }, '[Image]\nNice pic'],
      ['GIF', { viewType: 'Gif', text: '', file: null }, '[GIF]'],
      ['Sticker', { viewType: 'Sticker', text: '', file: null }, '[Sticker]'],
      ['Audio', { viewType: 'Audio', text: '', file: null }, '[Audio]'],
      ['Voice', { viewType: 'Voice', text: '', file: null }, '[Voice message]'],
      ['Video', { viewType: 'Video', text: '', file: null }, '[Video]'],
      ['File with name', { viewType: 'File', fileName: 'doc.pdf', text: '', file: null }, '[File: doc.pdf]'],
      ['File without name', { viewType: 'File', fileName: null, text: '', file: null }, '[File]'],
      ['VideochatInvitation', { viewType: 'VideochatInvitation', text: '', file: null }, '[Video chat invitation]'],
      ['Call', { viewType: 'Call', text: '', file: null }, '[Call]'],
      ['Webxdc', { viewType: 'Webxdc', text: '', file: null }, '[Webxdc app]'],
      ['Vcard', { viewType: 'Vcard', text: '', file: null }, '[Contact (vCard)]'],
      ['Unknown type', { viewType: 'SomeFutureType', text: '', file: null }, '[Attachment]'],
    ];

    for (const [label, msgOverrides, expected] of cases) {
      it(`formats ${label} as placeholder`, async () => {
        const { config, dc } = await buildSetupAdapter();
        dc.rpc.getMessage.mockResolvedValueOnce(makeMsg(msgOverrides));
        dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
        dc.rpc.getContact.mockResolvedValueOnce(makeContact());

        emitIncomingMsg();
        await flush();

        const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
        expect((msg.content as Record<string, unknown>).text).toBe(expected);
      });
    }

    it('skips truly empty Text messages', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ viewType: 'Text', text: '' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });
  });

  describe('inbound attachments', () => {
    it('base64-encodes small files into content.attachments', async () => {
      const { config, dc } = await buildSetupAdapter();
      vi.mocked(fs.statSync).mockReturnValueOnce({ size: 100 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('img') as ReturnType<typeof fs.readFileSync>);

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ viewType: 'Image', text: '', file: '/dc/blobs/photo.jpg' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      const content = msg.content as Record<string, unknown>;
      const attachments = content.attachments as Array<{ data: string; name: string; type?: string }>;
      expect(Array.isArray(attachments)).toBe(true);
      expect(attachments[0].data).toBe(Buffer.from('img').toString('base64'));
      expect(attachments[0].name).toBe('photo.jpg');
      expect(attachments[0].type).toBe('image');
    });

    it('passes on a file well past the old 5 MB cap, labelled by kind', async () => {
      const { config, dc } = await buildSetupAdapter();
      vi.mocked(fs.statSync).mockReturnValueOnce({ size: 25 * 1024 * 1024 } as ReturnType<typeof fs.statSync>);
      vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('ogg') as ReturnType<typeof fs.readFileSync>);

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ viewType: 'Voice', text: '', file: '/dc/blobs/note.ogg' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      const attachments = (msg.content as Record<string, unknown>).attachments as Array<{
        name: string;
        type?: string;
      }>;
      expect(attachments[0]).toMatchObject({ name: 'note.ogg', type: 'voice message' });
    });

    it('falls back to a placeholder that says why when file exceeds size limit', async () => {
      const { config, dc } = await buildSetupAdapter();
      vi.mocked(fs.statSync).mockReturnValueOnce({ size: 100 * 1024 * 1024 } as ReturnType<typeof fs.statSync>);

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ viewType: 'Image', text: '', file: '/dc/blobs/big.jpg' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      const content = msg.content as Record<string, unknown>;
      expect(content.text).toBe('[Image]\n(file not passed on: 100 MB is over the 64 MB limit)');
      expect(content.attachments).toBeUndefined();
    });

    it('falls back to placeholder when fs.statSync throws', async () => {
      const { config, dc } = await buildSetupAdapter();
      vi.mocked(fs.statSync).mockImplementationOnce(() => {
        throw new Error('no such file');
      });

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ viewType: 'Image', text: '', file: '/dc/blobs/missing.jpg' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).text).toBe('[Image]');
    });

    it('includes sender info in content', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'hi' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact({ address: 'alice@example.com', displayName: 'Alice' }));

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      const content = msg.content as Record<string, unknown>;
      expect(content.sender).toBe('Alice');
      expect(content.senderId).toBe('dc:alice@example.com');
    });
  });

  describe('MsgsChanged (message edits)', () => {
    function emitMsgsChanged(chatId = CHAT_ID, msgId = MSG_ID) {
      emitterRef.current!.emit('MsgsChanged', { chatId, msgId });
    }

    it('routes edited message with [Message edited] prefix', async () => {
      const { config, dc } = await buildSetupAdapter();
      // Deliver original so it lands in processedMsgIds
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'original' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();

      vi.mocked(config.onInbound).mockClear();

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'edited' }));
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitMsgsChanged();
      await settle();

      expect(vi.mocked(config.onInbound)).toHaveBeenCalledWith(
        PLATFORM_ID,
        null,
        expect.objectContaining({
          id: `edit-${MSG_ID}`,
        }),
      );
      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).text).toBe('[Message edited]\nedited');
    });

    it('ignores MsgsChanged for unseen message IDs', async () => {
      const { config } = await buildSetupAdapter();

      emitMsgsChanged(CHAT_ID, 999);
      await settle();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });

    it('ignores MsgsChanged with msgId = 0', async () => {
      const { config } = await buildSetupAdapter();

      emitMsgsChanged(CHAT_ID, 0);
      await settle();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });

    it('ignores edits from the bot itself', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text: 'original' }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();
      vi.mocked(config.onInbound).mockClear();

      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ fromId: 1, text: 'bot edit' }));
      emitMsgsChanged();
      await settle();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });
  });

  describe('IncomingReaction', () => {
    function emitIncomingReaction(chatId = CHAT_ID, contactId = 5, msgId = MSG_ID, reaction = '👍') {
      emitterRef.current!.emit('IncomingReaction', { chatId, contactId, msgId, reaction });
    }

    it('routes reaction to onInbound with [Reaction: ...] text', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());

      emitIncomingReaction();
      await settle();

      expect(vi.mocked(config.onInbound)).toHaveBeenCalledWith(
        PLATFORM_ID,
        null,
        expect.objectContaining({ id: `reaction-${MSG_ID}-5` }),
      );
      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).text).toBe('[Reaction: 👍]');
    });

    it('ignores empty reaction string', async () => {
      const { config } = await buildSetupAdapter();

      emitIncomingReaction(CHAT_ID, 5, MSG_ID, '');
      await settle();

      expect(vi.mocked(config.onInbound)).not.toHaveBeenCalled();
    });
  });

  describe('connectivity events', () => {
    it('debounces ConnectivityChanged and logs with label', async () => {
      const { log } = await import('../log.js');
      await buildSetupAdapter();

      emitterRef.current!.emit('ConnectivityChanged');
      emitterRef.current!.emit('ConnectivityChanged');
      emitterRef.current!.emit('ConnectivityChanged');

      const callsBefore = vi
        .mocked(log.info)
        .mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('connectivity')).length;
      expect(callsBefore).toBe(0);

      await vi.runAllTimersAsync();

      const connectivityCalls = vi
        .mocked(log.info)
        .mock.calls.filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('connectivity'));
      expect(connectivityCalls).toHaveLength(1);
      expect(connectivityCalls[0][0]).toBe('DeltaChat: connectivity changed (connected)');
    });

    it('labels connectivity levels correctly', async () => {
      const { log } = await import('../log.js');
      const { dc } = await buildSetupAdapter();

      const levels = [
        { level: 1000, label: 'not connected' },
        { level: 2000, label: 'connecting' },
        { level: 3000, label: 'working' },
        { level: 4000, label: 'connected' },
      ];

      for (const { level, label } of levels) {
        vi.mocked(log.info).mockClear();
        dc.rpc.getConnectivity.mockResolvedValue(level);
        // Reset lastConnectivityLabel by emitting a different level first
        emitterRef.current!.emit('ConnectivityChanged');
        await vi.runAllTimersAsync();
        const call = vi
          .mocked(log.info)
          .mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('connectivity'));
        expect(call?.[0]).toBe(`DeltaChat: connectivity changed (${label})`);
      }
    });

    it('logs ImapConnected', async () => {
      const { log } = await import('../log.js');
      await buildSetupAdapter();
      emitterRef.current!.emit('ImapConnected');
      expect(vi.mocked(log.info)).toHaveBeenCalledWith('DeltaChat: IMAP connected');
    });

    it('logs ImapInboxIdle (debounced)', async () => {
      const { log } = await import('../log.js');
      await buildSetupAdapter();
      emitterRef.current!.emit('ImapInboxIdle');
      await vi.runAllTimersAsync();
      expect(vi.mocked(log.info)).toHaveBeenCalledWith('DeltaChat: IMAP inbox idle (ready for instant delivery)');
    });

    it('logs SmtpConnected', async () => {
      const { log } = await import('../log.js');
      await buildSetupAdapter();
      emitterRef.current!.emit('SmtpConnected');
      expect(vi.mocked(log.info)).toHaveBeenCalledWith('DeltaChat: SMTP connected');
    });
  });

  describe('deliver — text message', () => {
    it('sends text via DC RPC and returns the message ID', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush(); // populate lastMsgId for ✅ reaction

      dc.rpc.sendMsg.mockClear();
      dc.rpc.sendReaction.mockClear();
      dc.rpc.sendMsg.mockResolvedValue(55);

      const result = await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { text: 'Hello world' },
      });

      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ text: 'Hello world' }),
      );
      expect(result).toBe('55');
    });

    it('sends ✅ reaction after text delivery', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();

      dc.rpc.sendReaction.mockClear();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { text: 'Response' },
      });

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, ['✅']);
    });

    it('does nothing for empty text', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.sendMsg.mockClear();

      const result = await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { text: '' },
      });

      expect(dc.rpc.sendMsg).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('ignores deliveries to non-dc platformIds', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.sendMsg.mockClear();

      const result = await adapter.deliver('tg:123', null, {
        kind: 'chat',
        content: { text: 'hello' },
      });

      expect(dc.rpc.sendMsg).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe('deliver — file message', () => {
    it('writes file to tmp and sends via DC RPC', async () => {
      const { adapter, dc } = await buildSetupAdapter();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { text: 'Here you go' },
        files: [{ filename: 'photo.jpg', data: Buffer.from('img-data') }],
      } as OutboundMessage);

      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('photo.jpg'),
        expect.any(Buffer),
      );
      expect(dc.rpc.sendMsg).toHaveBeenCalledWith(
        ACCOUNT_ID,
        CHAT_ID,
        expect.objectContaining({ file: expect.stringContaining('photo.jpg'), text: 'Here you go' }),
      );
    });

    it('sends ✅ reaction after file delivery', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat());
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg();
      await flush();

      dc.rpc.sendReaction.mockClear();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { text: '' },
        files: [{ filename: 'result.png', data: Buffer.from('data') }],
      } as OutboundMessage);

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, MSG_ID, ['✅']);
    });

    it('cleans up tmp dir after file send', async () => {
      const { adapter } = await buildSetupAdapter();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { text: '' },
        files: [{ filename: 'file.pdf', data: Buffer.from('data') }],
      } as OutboundMessage);

      expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith('/tmp/dc-out-abc', { recursive: true });
    });
  });

  describe('deliver — edit operation', () => {
    it('calls sendEditRequest', async () => {
      const { adapter, dc } = await buildSetupAdapter();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { operation: 'edit', messageId: '77', text: 'corrected' },
      });

      expect(dc.rpc.sendEditRequest).toHaveBeenCalledWith(ACCOUNT_ID, 77, 'corrected');
    });

    it('does nothing for non-numeric messageId', async () => {
      const { adapter, dc } = await buildSetupAdapter();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { operation: 'edit', messageId: 'NaN', text: 'text' },
      });

      expect(dc.rpc.sendEditRequest).not.toHaveBeenCalled();
    });
  });

  describe('deliver — reaction operation', () => {
    it('calls sendReaction with the emoji', async () => {
      const { adapter, dc } = await buildSetupAdapter();

      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat',
        content: { operation: 'reaction', messageId: '88', emoji: '❤️' },
      });

      expect(dc.rpc.sendReaction).toHaveBeenCalledWith(ACCOUNT_ID, 88, ['❤️']);
    });
  });
  describe('sender identity', () => {
    const FP = '0123456789ABCDEF0123456789ABCDEF01234567';
    const ENC_INFO = [
      'Messages are end-to-end encrypted.',
      'Fingerprints:',
      '',
      'alice (alice@relay-two.example):',
      '0123 4567 89AB CDEF 0123',
      '4567 89AB CDEF 0123 4567',
      '',
      'Me (bot@example.com):',
      'FEDC BA98 7654 3210 FEDC',
      'BA98 7654 3210 FEDC BA98',
      '',
      'Relays:',
      'alice@relay-two.example',
      'alice@relay-one.example',
    ].join('\n');

    function keyContact(address = 'alice@relay-two.example') {
      return makeContact({ address, isKeyContact: true });
    }

    it('identifies a key contact by fingerprint and merges its relay-address users', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValue(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValue(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValue(keyContact());
      dc.rpc.getContactEncryptionInfo.mockResolvedValue(ENC_INFO);

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).senderId).toBe(`dc:fp:${FP}`);
      expect(vi.mocked(mergeUsersInto)).toHaveBeenCalledWith(expect.objectContaining({ id: `dc:fp:${FP}` }), [
        'dc:alice@relay-two.example',
        'dc:alice@relay-one.example',
      ]);
    });

    it('keeps the same sender id when the contact arrives via another relay', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValue(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValue(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValue(keyContact('alice@relay-one.example'));
      dc.rpc.getContactEncryptionInfo.mockResolvedValue(
        ENC_INFO.replace('alice (alice@relay-two.example):', 'alice (alice@relay-one.example):'),
      );

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).senderId).toBe(`dc:fp:${FP}`);
    });

    it('falls back to the address for contacts without a key', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValue(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValue(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValue(makeContact({ isKeyContact: false }));

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).senderId).toBe('dc:alice@example.com');
      expect(dc.rpc.getContactEncryptionInfo).not.toHaveBeenCalled();
      expect(vi.mocked(mergeUsersInto)).not.toHaveBeenCalled();
    });

    it('falls back to the address when the fingerprint cannot be parsed', async () => {
      const { config, dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValue(makeMsg());
      dc.rpc.getBasicChatInfo.mockResolvedValue(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValue(keyContact());
      dc.rpc.getContactEncryptionInfo.mockResolvedValue('Something unexpected');

      emitIncomingMsg();
      await flush();

      const [, , msg] = vi.mocked(config.onInbound).mock.calls[0];
      expect((msg.content as Record<string, unknown>).senderId).toBe('dc:alice@relay-two.example');
    });

    it('openDM finds a fingerprint handle by scanning key contacts', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.getContactIds.mockResolvedValue([9, 12]);
      dc.rpc.getContact.mockImplementation(async (_a: number, id: number) =>
        id === 9 ? makeContact({ isKeyContact: false }) : keyContact(),
      );
      dc.rpc.getContactEncryptionInfo.mockResolvedValue(ENC_INFO);

      await expect(adapter.openDM!(`fp:${FP}`)).resolves.toBe('dc:77');
      expect(dc.rpc.createChatByContactId).toHaveBeenCalledWith(ACCOUNT_ID, 12);
    });

    it('openDM resolves an address handle by lookup', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      dc.rpc.lookupContactIdByAddr.mockResolvedValue(9);

      await expect(adapter.openDM!('alice@example.com')).resolves.toBe('dc:77');
      expect(dc.rpc.createChatByContactId).toHaveBeenCalledWith(ACCOUNT_ID, 9);
    });

    it('openDM throws for an unknown handle', async () => {
      const { adapter } = await buildSetupAdapter();
      await expect(adapter.openDM!(`fp:${FP}`)).rejects.toThrow('no known contact');
    });
  });

  describe('question cards (answered by reply)', () => {
    const askContent = (questionId: string, extra: Record<string, unknown> = {}) => ({
      type: 'ask_question',
      questionId,
      title: 'Prior notes exist',
      question: 'Use the existing note or start a new one?',
      options: [
        { label: 'Use existing', selectedLabel: 'Using existing', value: 'existing' },
        { label: 'New note', value: 'new' },
      ],
      ...extra,
    });

    async function deliverCard(
      adapter: Awaited<ReturnType<typeof buildSetupAdapter>>['adapter'],
      dc: ReturnType<typeof makeDcMock>,
      questionId: string,
      msgId: number,
      extra: Record<string, unknown> = {},
    ) {
      dc.rpc.sendMsg.mockResolvedValueOnce(msgId);
      return adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat-sdk',
        content: askContent(questionId, extra),
      } as OutboundMessage);
    }

    async function reply(dc: ReturnType<typeof makeDcMock>, text: string, quote: unknown = null, msgId = MSG_ID) {
      dc.rpc.getMessage.mockResolvedValueOnce(makeMsg({ text, quote }));
      dc.rpc.getBasicChatInfo.mockResolvedValueOnce(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValueOnce(makeContact());
      emitIncomingMsg(CHAT_ID, msgId);
      await flush();
    }

    beforeEach(() => {
      waiting.ids = null;
    });

    it('sends a question as numbered text and returns its message id', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      const id = await deliverCard(adapter, dc, 'q1', 501, { sender: 'Researcher' });
      expect(id).toBe('501');
      const sent = dc.rpc.sendMsg.mock.calls.at(-1)![2] as { text: string; overrideSenderName: string | null };
      expect(sent.text).toBe(
        '❓ Researcher: Prior notes exist\nUse the existing note or start a new one?\n1. Use existing\n2. New note\nReply with the number or the option.',
      );
      expect(sent.overrideSenderName).toBe('Researcher');
    });

    it('an unquoted number answers the only waiting card and is not routed as chat', async () => {
      const { adapter, config, dc } = await buildSetupAdapter();
      await deliverCard(adapter, dc, 'q1', 501);
      await reply(dc, '1');
      expect(config.onAction).toHaveBeenCalledWith('q1', 'existing', 'dc:alice@example.com', {
        messageId: '501',
        platformId: PLATFORM_ID,
        threadId: null,
      });
      expect(config.onInbound).not.toHaveBeenCalled();
      expect(dc.rpc.sendEditRequest).toHaveBeenCalledWith(ACCOUNT_ID, 501, expect.stringContaining('→ Using existing'));
    });

    it('an option label answers too', async () => {
      const { adapter, config, dc } = await buildSetupAdapter();
      await deliverCard(adapter, dc, 'q1', 501);
      await reply(dc, 'new note!');
      expect(config.onAction).toHaveBeenCalledWith('q1', 'new', expect.any(String), expect.anything());
    });

    it('text that names no option is ordinary chat', async () => {
      const { adapter, config, dc } = await buildSetupAdapter();
      await deliverCard(adapter, dc, 'q1', 501);
      await reply(dc, 'what do you mean?');
      expect(config.onAction).not.toHaveBeenCalled();
      expect(config.onInbound).toHaveBeenCalled();
    });

    it('with two cards waiting, an unquoted answer is ambiguous and a quoted one picks its card', async () => {
      const { adapter, config, dc } = await buildSetupAdapter();
      await deliverCard(adapter, dc, 'q1', 501);
      await deliverCard(adapter, dc, 'q2', 502);

      await reply(dc, '2', null, 601);
      expect(config.onAction).not.toHaveBeenCalled();
      expect(config.onInbound).not.toHaveBeenCalled();
      const notice = dc.rpc.sendMsg.mock.calls.at(-1)![2] as { text: string };
      expect(notice.text).toContain('Reply to (quote) the one you mean');

      await reply(dc, '2', { kind: 'WithMessage', text: '❓ Prior notes exist', messageId: 502 }, 602);
      expect(config.onAction).toHaveBeenCalledWith(
        'q2',
        'new',
        expect.any(String),
        expect.objectContaining({ messageId: '502' }),
      );
    });

    it('a card whose question is no longer waiting does not capture replies', async () => {
      const { adapter, config, dc } = await buildSetupAdapter();
      await deliverCard(adapter, dc, 'q1', 501);
      waiting.ids = new Set();
      await reply(dc, '1');
      expect(config.onAction).not.toHaveBeenCalled();
      expect(config.onInbound).toHaveBeenCalled();
    });

    it('an expired card stops matching unquoted replies but still takes a quoted one', async () => {
      const { adapter, config, dc } = await buildSetupAdapter();
      await deliverCard(adapter, dc, 'q1', 501, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      await reply(dc, '1', null, 601);
      expect(config.onAction).not.toHaveBeenCalled();
      await reply(dc, '1', { kind: 'WithMessage', text: 'card', messageId: 501 }, 602);
      expect(config.onAction).toHaveBeenCalledWith('q1', 'existing', expect.any(String), expect.anything());
    });

    it('an approval card terminal edit is rendered as text', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: '501',
          terminalCard: { title: 'Approval', question: 'Allow x?', resolution: 'Approved by Alan' },
        },
      } as OutboundMessage);
      expect(dc.rpc.sendEditRequest).toHaveBeenCalledWith(ACCOUNT_ID, 501, 'Approval\nAllow x?\n→ Approved by Alan');
    });

    it('a display card is sent as text', async () => {
      const { adapter, dc } = await buildSetupAdapter();
      await adapter.deliver(PLATFORM_ID, null, {
        kind: 'chat-sdk',
        content: {
          type: 'card',
          card: { title: 'Build', description: 'All green', actions: [{ label: 'Logs', url: 'https://x.test' }] },
          fallbackText: '',
        },
      } as OutboundMessage);
      const sent = dc.rpc.sendMsg.mock.calls.at(-1)![2] as { text: string };
      expect(sent.text).toBe('Build\nAll green\nLogs: https://x.test');
    });
  });
  describe('WebXDC app (/app)', () => {
    const APP_MSG = 900;

    /** A DM where /app was sent: returns the adapter with the instance recorded. */
    async function withApp() {
      const ctx = await buildSetupAdapter();
      const { dc } = ctx;
      dc.rpc.getMessage.mockResolvedValue(makeMsg({ text: '/app' }));
      dc.rpc.getBasicChatInfo.mockResolvedValue(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValue(makeContact());
      dc.rpc.sendMsg.mockResolvedValueOnce(APP_MSG);
      emitIncomingMsg();
      await settle();
      dc.rpc.sendWebxdcStatusUpdate.mockClear();
      return ctx;
    }

    /** The payloads pushed into the app, in order. */
    function pushed(dc: NonNullable<typeof dcRef.current>) {
      return dc.rpc.sendWebxdcStatusUpdate.mock.calls.map(
        (c: unknown[]) =>
          JSON.parse(c[2] as string) as { payload: Record<string, unknown>; notify?: Record<string, string> },
      );
    }

    it('/app in a DM sends the app and tells it its id; nothing reaches the agent', async () => {
      const { dc, received } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValue(makeMsg({ text: '/app' }));
      dc.rpc.getBasicChatInfo.mockResolvedValue(makeChat({ chatType: 'Single' }));
      dc.rpc.getContact.mockResolvedValue(makeContact());
      dc.rpc.sendMsg.mockResolvedValueOnce(APP_MSG);
      emitIncomingMsg();
      await flush();

      const sent = dc.rpc.sendMsg.mock.calls.at(-1)![2] as { filename: string };
      expect(sent.filename).toBe('nanoclaw.xdc');
      expect(pushed(dc).map((u) => u.payload)).toEqual([{ type: 'meta', msgId: APP_MSG }]);
      expect(received).toHaveLength(0);
    });

    it('/app in a group is refused', async () => {
      const { dc } = await buildSetupAdapter();
      dc.rpc.getMessage.mockResolvedValue(makeMsg({ text: '/app' }));
      dc.rpc.getBasicChatInfo.mockResolvedValue(makeChat({ chatType: 'Group' }));
      dc.rpc.getContact.mockResolvedValue(makeContact());
      emitIncomingMsg();
      await settle();
      const sent = dc.rpc.sendMsg.mock.calls.at(-1)![2] as { text: string; filename: string | null };
      expect(sent.text).toBe('The app works in a direct chat only.');
      expect(sent.filename).not.toBe('nanoclaw.xdc');
    });

    it("routes the app's messages to the agent on the app's thread, skipping the bot's own echo", async () => {
      const { dc, received } = await withApp();
      dc.rpc.getWebxdcStatusUpdates.mockResolvedValueOnce(
        JSON.stringify([
          { serial: 3, payload: { type: 'meta', msgId: APP_MSG } },
          { serial: 4, payload: { type: 'ping' } },
          { serial: 5, payload: { type: 'user_message', id: 'u1', content: 'hello from the app' } },
          { serial: 6, payload: { type: 'user_message', id: 'u2', content: 'and again' } },
        ]),
      );
      emitterRef.current!.emit('WebxdcStatusUpdate', { msgId: APP_MSG, statusUpdateSerial: 6 });
      await settle();

      expect(dc.rpc.getWebxdcStatusUpdates).toHaveBeenLastCalledWith(ACCOUNT_ID, APP_MSG, 0);
      expect(received.map((r) => r.threadId)).toEqual([`xdc:${APP_MSG}`, `xdc:${APP_MSG}`]);
      const first = received[0].message;
      expect(first.id).toBe(`xdc-${APP_MSG}-5`);
      expect((first.content as { text: string }).text).toMatch(/NanoClaw app[\s\S]*\nhello from the app$/);
      expect((first.content as { senderId: string }).senderId).toBe('dc:alice@example.com');

      // The next read starts after the last serial seen: nothing is read twice.
      emitterRef.current!.emit('WebxdcStatusUpdate', { msgId: APP_MSG, statusUpdateSerial: 7 });
      await settle();
      expect(dc.rpc.getWebxdcStatusUpdates).toHaveBeenLastCalledWith(ACCOUNT_ID, APP_MSG, 6);
    });

    it('ignores updates from an app instance the bot did not send', async () => {
      const { dc, received } = await withApp();
      emitterRef.current!.emit('WebxdcStatusUpdate', { msgId: 12345, statusUpdateSerial: 1 });
      await settle();
      expect(dc.rpc.getWebxdcStatusUpdates).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
    });

    it('delivers a reply on the app thread into the app, with a notification, not into the chat', async () => {
      const { adapter, dc } = await withApp();
      dc.rpc.sendMsg.mockClear();
      const id = await adapter.deliver(PLATFORM_ID, `xdc:${APP_MSG}`, {
        kind: 'chat',
        content: { text: 'Hi **there**' },
      });

      expect(dc.rpc.sendMsg).not.toHaveBeenCalled();
      const [update] = pushed(dc);
      expect(update.payload).toMatchObject({ type: 'message', id, title: 'Andy', content: 'Hi **there**' });
      expect(update.notify).toEqual({ '*': 'Andy: Hi **there**' });
    });

    it('turns a question card into buttons, and a tap answers the question', async () => {
      const { adapter, dc, config } = await withApp();
      await adapter.deliver(PLATFORM_ID, `xdc:${APP_MSG}`, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'q9',
          title: 'Pick one',
          question: 'Which?',
          options: ['Red', 'Blue'],
        },
      });
      const card = pushed(dc)[0].payload;
      expect(card).toMatchObject({ type: 'interactive', surfaceId: 'q9' });
      expect((card.components as Array<{ label: string }>).map((c) => c.label)).toEqual(['Red', 'Blue']);
      const blue = (card.components as Array<{ id: string; label: string }>)[1];

      dc.rpc.sendWebxdcStatusUpdate.mockClear();
      dc.rpc.getWebxdcStatusUpdates.mockResolvedValueOnce(
        JSON.stringify([{ serial: 8, payload: { type: 'action', actionId: blue.id, value: 'Blue', surfaceId: 'q9' } }]),
      );
      emitterRef.current!.emit('WebxdcStatusUpdate', { msgId: APP_MSG, statusUpdateSerial: 8 });
      await settle();

      expect(config.onAction).toHaveBeenCalledWith('q9', blue.id, 'dc:alice@example.com', {
        messageId: String(APP_MSG),
        platformId: PLATFORM_ID,
        threadId: `xdc:${APP_MSG}`,
      });
      expect(pushed(dc).map((u) => u.payload)).toEqual([{ type: 'resolved', surfaceId: 'q9', content: '✓ Blue' }]);
    });

    it('shows typing in the app status line, once per change, and never reacts in the chat', async () => {
      const { adapter, dc } = await withApp();
      dc.rpc.sendReaction.mockClear();
      await adapter.setTyping!(PLATFORM_ID, `xdc:${APP_MSG}`);
      await adapter.setTyping!(PLATFORM_ID, `xdc:${APP_MSG}`);
      await adapter.setTyping!(PLATFORM_ID, `xdc:${APP_MSG}`, 'thinking');
      expect(pushed(dc).map((u) => u.payload)).toEqual([{ type: 'status', text: 'thinking' }]);
      expect(pushed(dc)[0].notify).toBeUndefined();
      expect(dc.rpc.sendReaction).not.toHaveBeenCalled();
    });

    it('puts a small image into the app inline and a document into the chat', async () => {
      const { adapter, dc } = await withApp();
      dc.rpc.sendMsg.mockClear();
      await adapter.deliver(PLATFORM_ID, `xdc:${APP_MSG}`, {
        kind: 'chat',
        content: { text: 'Here you go' },
        files: [
          { filename: 'chart.png', data: Buffer.from('png-bytes') },
          { filename: 'report.pdf', data: Buffer.from('pdf-bytes') },
        ],
      });
      const content = pushed(dc)[0].payload.content as string;
      expect(content).toContain('![chart.png](data:image/png;base64,');
      expect(content).toContain('*report.pdf* is in the chat as an attachment');
      expect(dc.rpc.sendMsg).toHaveBeenCalledTimes(1);
      expect((dc.rpc.sendMsg.mock.calls[0][2] as { filename: string }).filename).toBe('report.pdf');
    });
  });
});
