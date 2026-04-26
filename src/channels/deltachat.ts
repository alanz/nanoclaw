/**
 * DeltaChat channel adapter (v2).
 *
 * Bridges NanoClaw with DeltaChat via the stdio-rpc-server.
 * Each DeltaChat chat is a platformId (`dc:{chatId}`), threadId is always null.
 *
 * Inbound: debounces rapid messages before routing, attaches 👀 on receipt.
 * Outbound: sends text/files, handles edit/reaction operations; sends ✅ on delivery.
 * Typing: sends 💭 on the last incoming message for the platformId.
 *
 * Credentials: set DELTACHAT_CHATMAIL_QR (chatmail QR) or DELTACHAT_ADDR +
 * DELTACHAT_MAIL_PW in .env. DELTACHAT_CHATMAIL_QR defaults to
 * dcaccount:https://nine.testrun.org/new (standard relay) if unset.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startDeltaChat } from '@deltachat/stdio-rpc-server';
import type { DeltaChatOverJsonRpcServer } from '@deltachat/stdio-rpc-server';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

/** Files larger than this are delivered as placeholders, not base64-embedded. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Wait this long for additional messages from the same chat before routing to agent. */
const DEBOUNCE_MS = 1500;

/** Track incoming message IDs for edit detection for this long. */
const EDIT_TRACK_TTL_MS = 60 * 60 * 1000;

type InboundAttachment = { data: string; name: string; type?: string };

type DebounceEntry = {
  msgIds: number[];
  parts: string[];
  attachments: InboundAttachment[];
  sender: string;
  senderName: string;
  firstTimestamp: string;
  isGroup: boolean;
};

function chatIdFromPlatformId(platformId: string): number | null {
  const m = platformId.match(/^dc:(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function platformIdForChat(chatId: number): string {
  return `dc:${chatId}`;
}

function mediaPlaceholder(viewType: string, fileName: string | null, caption: string): string {
  let label: string;
  switch (viewType) {
    case 'Image':
      label = '[Image]';
      break;
    case 'Gif':
      label = '[GIF]';
      break;
    case 'Video':
      label = '[Video]';
      break;
    case 'File':
      label = fileName ? `[File: ${fileName}]` : '[File]';
      break;
    case 'Sticker':
      label = '[Sticker]';
      break;
    case 'Audio':
      label = '[Audio]';
      break;
    case 'Voice':
      label = '[Voice message]';
      break;
    case 'Vcard':
      label = '[Contact (vCard)]';
      break;
    case 'Webxdc':
      label = '[Webxdc app]';
      break;
    case 'VideochatInvitation':
      label = '[Video chat invitation]';
      break;
    case 'Call':
      label = '[Call]';
      break;
    default:
      label = '[Attachment]';
      break;
  }
  return caption ? `${label}\n${caption}` : label;
}

function copyAvatarToDataDir(dataDir: string): string | null {
  const avatarSource = path.resolve(process.cwd(), 'assets', 'nanoclaw-profile.jpeg');
  try {
    if (!fs.existsSync(avatarSource)) return null;
    const dest = path.join(dataDir, 'nanoclaw-avatar.jpeg');
    fs.copyFileSync(avatarSource, dest);
    return dest;
  } catch {
    return null;
  }
}

interface DeltaChatCreateOpts {
  chatmailQr: string | undefined;
  addr: string | undefined;
  mailPw: string | undefined;
  dataDir: string;
}

function createAdapter(opts: DeltaChatCreateOpts): ChannelAdapter {
  const { chatmailQr, addr, mailPw, dataDir } = opts;

  let dc: DeltaChatOverJsonRpcServer | null = null;
  let accountId: number | null = null;
  let _connected = false;
  let channelSetup: ChannelSetup | null = null;

  /** Last incoming message ID per platformId — used for reactions. */
  const lastMsgId = new Map<string, number>();
  /** Debounce state: accumulate rapid messages per chat before routing. */
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const debounceEntries = new Map<string, DebounceEntry>();
  /** Dedup set for IncomingMsg (short window) and edit-detection set (1-hour window). */
  const seenMsgIds = new Set<number>();
  const processedMsgIds = new Set<number>();

  function flushDebounce(platformId: string): void {
    const entry = debounceEntries.get(platformId);
    if (!entry || !channelSetup) return;
    debounceEntries.delete(platformId);
    debounceTimers.delete(platformId);

    const text = entry.parts.join('\n');
    const content: Record<string, unknown> = {
      text,
      sender: entry.senderName,
      senderId: `dc:${entry.sender}`,
    };
    if (entry.attachments.length > 0) {
      content.attachments = entry.attachments;
    }

    const lastId = entry.msgIds[entry.msgIds.length - 1];
    channelSetup.onInbound(platformId, null, {
      id: String(lastId),
      kind: 'chat',
      content,
      timestamp: entry.firstTimestamp,
      isMention: !entry.isGroup, // DMs are always addressed to the bot
    });
  }

  async function sendText(platformId: string, text: string): Promise<string | null> {
    const chatId = chatIdFromPlatformId(platformId);
    if (chatId === null || !dc || accountId === null) return null;
    const msgId = await dc.rpc.sendMsg(accountId, chatId, {
      text,
      html: null,
      viewtype: null,
      file: null,
      filename: null,
      location: null,
      overrideSenderName: null,
      quotedMessageId: null,
      quotedText: null,
    });
    return String(msgId);
  }

  async function sendFileTmp(platformId: string, filePath: string, caption: string | undefined): Promise<void> {
    const chatId = chatIdFromPlatformId(platformId);
    if (chatId === null || !dc || accountId === null) return;
    await dc.rpc.sendMsg(accountId, chatId, {
      text: caption ?? null,
      html: null,
      viewtype: null,
      file: filePath,
      filename: path.basename(filePath),
      location: null,
      overrideSenderName: null,
      quotedMessageId: null,
      quotedText: null,
    });
  }

  async function sendDoneReaction(platformId: string): Promise<void> {
    const msgId = lastMsgId.get(platformId);
    if (msgId === undefined || !dc || accountId === null) return;
    try {
      await dc.rpc.sendReaction(accountId, msgId, ['✅']);
    } catch (err) {
      log.warn('DeltaChat: failed to send ✅ reaction', { err, platformId });
    }
  }

  const adapter: ChannelAdapter = {
    name: 'deltachat',
    channelType: 'deltachat',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      channelSetup = config;
      fs.mkdirSync(dataDir, { recursive: true });

      // DeltaChat requires accounts.toml on startup
      const accountsToml = path.join(dataDir, 'accounts.toml');
      if (!fs.existsSync(accountsToml)) {
        fs.writeFileSync(accountsToml, 'selected_account = 0\nnext_id = 1\naccounts = []\n', 'utf8');
      }

      dc = await startDeltaChat(dataDir);

      let accounts = await dc.rpc.getAllAccounts();
      let account = accounts[0];
      if (!account) {
        const id = await dc.rpc.addAccount();
        accounts = await dc.rpc.getAllAccounts();
        account = accounts.find((a) => a.id === id) ?? accounts[0];
      }
      if (!account) throw new Error('DeltaChat: failed to get or create account');
      accountId = account.id;

      if (account.kind === 'Unconfigured') {
        if (chatmailQr) {
          await dc.rpc.batchSetConfig(account.id, {
            bot: '1',
            displayname: ASSISTANT_NAME,
          });
          await dc.rpc.setConfigFromQr(account.id, chatmailQr);
          await dc.rpc.configure(account.id);
        } else if (addr && mailPw) {
          await dc.rpc.batchSetConfig(account.id, {
            addr,
            mail_pw: mailPw,
            bot: '1',
            displayname: ASSISTANT_NAME,
          });
          await dc.rpc.configure(account.id);
        } else {
          throw new Error(
            'DeltaChat: no credentials — set DELTACHAT_CHATMAIL_QR or DELTACHAT_ADDR + DELTACHAT_MAIL_PW',
          );
        }
        log.info('DeltaChat account configured');
      }

      const avatarPath = copyAvatarToDataDir(dataDir);
      if (avatarPath) {
        await dc.rpc.batchSetConfig(account.id, { selfavatar: avatarPath });
        log.debug('DeltaChat: avatar set');
      }

      await dc.rpc.startIo(account.id);

      const selfAddr = await dc.rpc.getConfig(account.id, 'addr');
      const inviteQr = await dc.rpc.getChatSecurejoinQrCode(account.id, null);
      log.info('DeltaChat ready', { addr: selfAddr, inviteQr });
      fs.writeFileSync(path.join(dataDir, 'invite-url'), inviteQr, 'utf8');

      const emitter = dc.getContextEvents(account.id);

      // --- Inbound messages ---
      emitter.on('IncomingMsg', async ({ chatId, msgId }: { chatId: number; msgId: number }) => {
        if (seenMsgIds.has(msgId)) return;
        seenMsgIds.add(msgId);
        setTimeout(() => seenMsgIds.delete(msgId), 60_000);
        processedMsgIds.add(msgId);
        setTimeout(() => processedMsgIds.delete(msgId), EDIT_TRACK_TTL_MS);

        try {
          const dcRef = dc!;
          const aid = accountId!;
          const msg = await dcRef.rpc.getMessage(aid, msgId);

          if (msg.isInfo) return;
          if (msg.systemMessageType === 'AutocryptSetupMessage') return;
          // Skip the bot's own outgoing messages (DC fires IncomingMsg for group msgs too)
          if (msg.fromId === 1) return;

          const chat = await dcRef.rpc.getBasicChatInfo(aid, chatId);
          const contact = await dcRef.rpc.getContact(aid, msg.fromId);
          const isGroup = chat.chatType !== 'Single';
          const platformId = platformIdForChat(chatId);
          const sender = contact.address ?? String(msg.fromId);
          const senderName = contact.displayName ?? sender;

          channelSetup!.onMetadata(platformId, chat.name, isGroup);

          const text = msg.text ?? '';

          // Basic commands — respond directly, don't route to agent
          if (text.trim() === '/ping') {
            await sendText(platformId, `${ASSISTANT_NAME} is online.`);
            return;
          }
          if (text.trim() === '/chatid') {
            await sendText(platformId, `Chat ID: ${platformId}`);
            return;
          }

          // React with 👀 to acknowledge receipt; track msgId for typing/done reactions
          lastMsgId.set(platformId, msgId);
          try {
            await dcRef.rpc.sendReaction(aid, msgId, ['👀']);
          } catch (err) {
            log.warn('DeltaChat: failed to send 👀 reaction', { err, msgId });
          }

          // Build text content, handling quotes and media
          const contentParts: string[] = [];
          const attachments: InboundAttachment[] = [];

          if (msg.quote) {
            const q = msg.quote as { kind: string; text: string; authorDisplayName?: string };
            if (q.kind === 'WithMessage' && q.text) {
              const author = q.authorDisplayName ? ` (${q.authorDisplayName})` : '';
              contentParts.push(`[Replying to${author}: "${q.text}"]`);
            } else if (q.kind === 'JustText' && q.text) {
              contentParts.push(`[Quoting: "${q.text}"]`);
            }
          }

          const viewType = (msg.viewType as string | undefined) ?? 'Unknown';
          if (viewType === 'Text' || viewType === 'Unknown') {
            if (text) contentParts.push(text);
          } else if (msg.file) {
            // Try to attach the file if it's small enough
            try {
              const stat = fs.statSync(msg.file as string);
              if (stat.size <= MAX_ATTACHMENT_BYTES) {
                const data = fs.readFileSync(msg.file as string);
                const filename = path.basename(msg.file as string);
                const attachType = viewType === 'Image' || viewType === 'Gif' ? 'image' : 'file';
                attachments.push({ data: data.toString('base64'), name: filename, type: attachType });
                if (text) contentParts.push(text);
              } else {
                contentParts.push(
                  mediaPlaceholder(viewType, (msg.fileName as string | null | undefined) ?? null, text),
                );
              }
            } catch {
              contentParts.push(mediaPlaceholder(viewType, (msg.fileName as string | null | undefined) ?? null, text));
            }
          } else {
            contentParts.push(mediaPlaceholder(viewType, (msg.fileName as string | null | undefined) ?? null, text));
          }

          const combinedText = contentParts.join('\n');
          if (!combinedText && attachments.length === 0) return;

          // Debounce: accumulate rapid messages from the same chat
          const existing = debounceEntries.get(platformId);
          if (existing) {
            existing.msgIds.push(msgId);
            if (combinedText) existing.parts.push(combinedText);
            existing.attachments.push(...attachments);
            clearTimeout(debounceTimers.get(platformId));
          } else {
            debounceEntries.set(platformId, {
              msgIds: [msgId],
              parts: combinedText ? [combinedText] : [],
              attachments,
              sender,
              senderName,
              firstTimestamp: new Date((msg.timestamp as number) * 1000).toISOString(),
              isGroup,
            });
          }
          debounceTimers.set(
            platformId,
            setTimeout(() => flushDebounce(platformId), DEBOUNCE_MS),
          );
        } catch (err) {
          log.error('DeltaChat: failed to process IncomingMsg', { err, chatId, msgId });
        }
      });

      // --- Message edits ---
      emitter.on('MsgsChanged', async ({ chatId, msgId }: { chatId: number; msgId: number }) => {
        if (!msgId || !processedMsgIds.has(msgId)) return;

        try {
          const dcRef = dc!;
          const aid = accountId!;
          const msg = await dcRef.rpc.getMessage(aid, msgId);

          if (msg.isInfo || msg.systemMessageType === 'AutocryptSetupMessage' || msg.fromId === 1) return;

          const platformId = platformIdForChat(chatId);
          const contact = await dcRef.rpc.getContact(aid, msg.fromId);
          const senderName = contact.displayName ?? contact.address ?? String(msg.fromId);
          const sender = contact.address ?? String(msg.fromId);
          const text = (msg.text as string | undefined) ?? '';
          if (!text) return;

          // Block IncomingMsg from double-delivering the same edit
          seenMsgIds.add(msgId);
          setTimeout(() => seenMsgIds.delete(msgId), 60_000);

          log.debug('DeltaChat: message edited', { platformId, msgId });

          channelSetup!.onInbound(platformId, null, {
            id: `edit-${msgId}`,
            kind: 'chat',
            content: {
              text: `[Message edited]\n${text}`,
              sender: senderName,
              senderId: `dc:${sender}`,
            },
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          log.error('DeltaChat: failed to process MsgsChanged', { err, chatId, msgId });
        }
      });

      // --- Incoming reactions ---
      emitter.on(
        'IncomingReaction',
        async ({
          chatId,
          contactId,
          msgId,
          reaction,
        }: {
          chatId: number;
          contactId: number;
          msgId: number;
          reaction: string;
        }) => {
          if (!reaction) return;
          try {
            const contact = await dc!.rpc.getContact(accountId!, contactId);
            const sender = contact.address ?? String(contactId);
            const senderName = contact.displayName ?? sender;
            const platformId = platformIdForChat(chatId);

            log.debug('DeltaChat: incoming reaction', { platformId, sender, reaction, msgId });

            channelSetup!.onInbound(platformId, null, {
              id: `reaction-${msgId}-${contactId}`,
              kind: 'chat',
              content: {
                text: `[Reaction: ${reaction}]`,
                sender: senderName,
                senderId: `dc:${sender}`,
              },
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            log.error('DeltaChat: failed to process IncomingReaction', { err, chatId, contactId, msgId, reaction });
          }
        },
      );

      // --- Connectivity monitoring ---
      let connectivityDebounce: ReturnType<typeof setTimeout> | null = null;
      let lastConnectivityLabel: string | null = null;

      const logConnectivity = async () => {
        try {
          const level = await dc!.rpc.getConnectivity(accountId!);
          let label: string;
          if (level >= 4000) label = 'connected';
          else if (level >= 3000) label = 'working';
          else if (level >= 2000) label = 'connecting';
          else label = 'not connected';
          if (label !== lastConnectivityLabel) {
            lastConnectivityLabel = label;
            log.info(`DeltaChat: connectivity changed (${label})`);
          }
        } catch {
          if (lastConnectivityLabel !== null) {
            lastConnectivityLabel = null;
            log.info('DeltaChat: connectivity changed');
          }
        }
      };

      emitter.on('ConnectivityChanged', () => {
        if (connectivityDebounce) clearTimeout(connectivityDebounce);
        connectivityDebounce = setTimeout(logConnectivity, 500);
      });

      let imapIdleDebounce: ReturnType<typeof setTimeout> | null = null;
      let imapIdleLogged = false;
      emitter.on('ImapConnected', () => {
        imapIdleLogged = false;
        log.info('DeltaChat: IMAP connected');
      });
      emitter.on('ImapInboxIdle', () => {
        if (imapIdleDebounce) clearTimeout(imapIdleDebounce);
        imapIdleDebounce = setTimeout(() => {
          if (!imapIdleLogged) {
            imapIdleLogged = true;
            log.info('DeltaChat: IMAP inbox idle (ready for instant delivery)');
          }
        }, 500);
      });
      emitter.on('SmtpConnected', () => {
        log.info('DeltaChat: SMTP connected');
      });

      _connected = true;
      log.info('DeltaChat channel connected');
    },

    async teardown(): Promise<void> {
      if (dc && accountId !== null) {
        try {
          await dc.rpc.stopIo(accountId);
        } catch (err) {
          log.warn('DeltaChat: error stopping IO on teardown', { err });
        }
      }
      _connected = false;
    },

    isConnected(): boolean {
      return _connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!platformId.startsWith('dc:')) return undefined;
      const chatId = chatIdFromPlatformId(platformId);
      if (chatId === null || !dc || accountId === null) return undefined;

      const content = message.content as Record<string, unknown>;

      // edit_message: { operation: 'edit', messageId: platformMsgId, text }
      if (content.operation === 'edit') {
        const rawId = content.messageId;
        const text = content.text;
        if (typeof rawId === 'string' && typeof text === 'string') {
          const msgId = parseInt(rawId, 10);
          if (!isNaN(msgId)) {
            try {
              await dc.rpc.sendEditRequest(accountId, msgId, text);
            } catch (err) {
              log.warn('DeltaChat: failed to edit message', { err, platformId, msgId });
            }
          }
        }
        return undefined;
      }

      // add_reaction: { operation: 'reaction', messageId: platformMsgId, emoji }
      if (content.operation === 'reaction') {
        const rawId = content.messageId;
        const emoji = content.emoji;
        if (typeof rawId === 'string' && typeof emoji === 'string') {
          const msgId = parseInt(rawId, 10);
          if (!isNaN(msgId)) {
            try {
              await dc.rpc.sendReaction(accountId, msgId, [emoji]);
            } catch (err) {
              log.warn('DeltaChat: failed to send reaction', { err, platformId, msgId });
            }
          }
        }
        return undefined;
      }

      const text = typeof content.text === 'string' ? content.text : '';

      // send_file: host has resolved the file buffers into message.files
      if (message.files && message.files.length > 0) {
        for (const file of message.files) {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-out-'));
          const tmpPath = path.join(tmpDir, file.filename);
          try {
            fs.writeFileSync(tmpPath, file.data);
            await sendFileTmp(platformId, tmpPath, text || undefined);
          } finally {
            try {
              fs.rmSync(tmpDir, { recursive: true });
            } catch {
              // best-effort cleanup
            }
          }
        }
        await sendDoneReaction(platformId);
        return undefined;
      }

      // Plain text message
      if (!text) return undefined;
      const platformMsgId = await sendText(platformId, text);
      await sendDoneReaction(platformId);
      return platformMsgId ?? undefined;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      const msgId = lastMsgId.get(platformId);
      if (msgId === undefined || !dc || accountId === null) return;
      try {
        await dc.rpc.sendReaction(accountId, msgId, ['💭']);
      } catch (err) {
        log.warn('DeltaChat: failed to send 💭 typing reaction', { err, platformId });
      }
    },
  };

  return adapter;
}

registerChannelAdapter('deltachat', {
  factory: () => {
    const env = readEnvFile(['DELTACHAT_CHATMAIL_QR', 'DELTACHAT_ADDR', 'DELTACHAT_MAIL_PW', 'DELTACHAT_DATA_DIR']);

    const chatmailQr = env.DELTACHAT_CHATMAIL_QR ?? 'dcaccount:https://nine.testrun.org/new';
    const addr = env.DELTACHAT_ADDR;
    const mailPw = env.DELTACHAT_MAIL_PW;

    if (!(addr && mailPw) && !chatmailQr) {
      return null; // not configured — channel is skipped
    }

    const rawDataDir = env.DELTACHAT_DATA_DIR ?? 'store/deltachat';
    const dataDir = path.resolve(rawDataDir.replace(/^~/, os.homedir()));

    return createAdapter({ chatmailQr, addr, mailPw, dataDir });
  },
  containerConfig: (() => {
    const e = readEnvFile(['DELTACHAT_CHATMAIL_QR', 'DELTACHAT_ADDR', 'DELTACHAT_MAIL_PW', 'DELTACHAT_DATA_DIR']);
    return {
      env: {
        DELTACHAT_CHATMAIL_QR: e.DELTACHAT_CHATMAIL_QR ?? 'dcaccount:https://nine.testrun.org/new',
        DELTACHAT_ADDR: e.DELTACHAT_ADDR ?? '',
        DELTACHAT_MAIL_PW: e.DELTACHAT_MAIL_PW ?? '',
        DELTACHAT_DATA_DIR: e.DELTACHAT_DATA_DIR ?? '',
      },
    };
  })(),
});
