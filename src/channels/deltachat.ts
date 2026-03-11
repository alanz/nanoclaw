import fs from 'fs';
import path from 'path';
import { startDeltaChat } from '@deltachat/stdio-rpc-server';
import type { DeltaChatOverJsonRpcServer } from '@deltachat/stdio-rpc-server';
import { registerChannel } from './registry.js';
import type {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { readEnvFile } from '../env.js';
import { HOME_DIR, ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';

function jidForChat(chatId: number): string {
  return `dc:${chatId}`;
}

function chatIdFromJid(jid: string): number | null {
  const m = jid.match(/^dc:(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Format a non-text viewType as a readable placeholder with optional caption. */
function mediaPlaceholder(
  viewType: string,
  fileName: string | null,
  caption: string,
): string {
  let label: string;
  switch (viewType) {
    case 'Image':
      label = '[Image]';
      break;
    case 'Gif':
      label = '[GIF]';
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
    case 'Video':
      label = '[Video]';
      break;
    case 'File':
      label = fileName ? `[File: ${fileName}]` : '[File]';
      break;
    case 'VideochatInvitation':
      label = '[Video chat invitation]';
      break;
    case 'Call':
      label = '[Call]';
      break;
    case 'Webxdc':
      label = '[Webxdc app]';
      break;
    case 'Vcard':
      label = '[Contact (vCard)]';
      break;
    default:
      label = '[Attachment]';
      break;
  }
  return caption ? `${label}\n${caption}` : label;
}

export interface DeltaChatChannelOpts {
  chatmailQr: string | undefined;
  addr: string | undefined;
  mailPw: string | undefined;
  dataDir: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DeltaChatChannel implements Channel {
  name = 'deltachat';
  private dc: DeltaChatOverJsonRpcServer | null = null;
  private accountId: number | null = null;
  private _connected = false;
  /** Track the last incoming message ID per JID for reactions. */
  private lastMsgId = new Map<string, number>();

  constructor(private readonly opts: DeltaChatChannelOpts) {}

  async connect(): Promise<void> {
    const { chatmailQr, addr, mailPw, dataDir } = this.opts;
    fs.mkdirSync(dataDir, { recursive: true });

    // DeltaChat RPC server requires accounts.toml to exist on startup
    const accountsToml = path.join(dataDir, 'accounts.toml');
    if (!fs.existsSync(accountsToml)) {
      fs.writeFileSync(
        accountsToml,
        'selected_account = 0\nnext_id = 1\naccounts = []\n',
        'utf8',
      );
    }

    this.dc = await startDeltaChat(dataDir);

    // Get or create account
    let accounts = await this.dc.rpc.getAllAccounts();
    let account = accounts[0];
    if (!account) {
      const id = await this.dc.rpc.addAccount();
      accounts = await this.dc.rpc.getAllAccounts();
      account = accounts.find((a) => a.id === id) ?? accounts[0];
    }

    this.accountId = account.id;

    // Configure if unconfigured
    if (account.kind === 'Unconfigured') {
      if (chatmailQr) {
        await this.dc.rpc.batchSetConfig(account.id, {
          bot: '1',
          e2ee_enabled: '1',
          displayname: 'NanoClaw',
        });
        await this.dc.rpc.setConfigFromQr(account.id, chatmailQr);
        await this.dc.rpc.configure(account.id);
      } else if (addr && mailPw) {
        await this.dc.rpc.batchSetConfig(account.id, {
          addr,
          mail_pw: mailPw,
          bot: '1',
          e2ee_enabled: '1',
          displayname: 'NanoClaw',
        });
        await this.dc.rpc.configure(account.id);
      } else {
        throw new Error(
          'DeltaChat: no credentials. Set DELTACHAT_CHATMAIL_QR or DELTACHAT_ADDR + DELTACHAT_MAIL_PW in .env',
        );
      }
      logger.info('DeltaChat account configured');
    }

    await this.dc.rpc.startIo(account.id);

    // Listen for incoming messages
    const emitter = this.dc.getContextEvents(account.id);
    const seenMsgIds = new Set<number>();

    emitter.on(
      'IncomingMsg',
      async ({ chatId, msgId }: { chatId: number; msgId: number }) => {
        if (seenMsgIds.has(msgId)) return;
        seenMsgIds.add(msgId);
        setTimeout(() => seenMsgIds.delete(msgId), 60_000);

        try {
          const dc = this.dc!;
          const aid = this.accountId!;
          const msg = await dc.rpc.getMessage(aid, msgId);

          // Skip info/system messages
          if (msg.isInfo) return;

          const chat = await dc.rpc.getBasicChatInfo(aid, chatId);
          const contact = await dc.rpc.getContact(aid, msg.fromId);
          const isGroup = chat.chatType !== 100; // 100 = single/DM in DC

          const jid = jidForChat(chatId);
          const sender = contact.address ?? String(msg.fromId);
          const senderName = contact.displayName ?? sender;
          const text = msg.text ?? '';

          // Always emit chat metadata (enables group discovery for unregistered chats)
          this.opts.onChatMetadata(
            jid,
            new Date().toISOString(),
            chat.name,
            'deltachat',
            isGroup,
          );

          // /ping works in any chat (registered or not)
          if (text.trim() === '/ping') {
            await this.sendMessage(jid, `${ASSISTANT_NAME} is online.`);
            return;
          }

          // /help works in any chat (registered or not)
          if (text.trim() === '/help') {
            await this.sendMessage(
              jid,
              'Available commands:\n/ping — check if Andy is online\n/chatid — show this chat\'s ID and registration status\n/help — show this message',
            );
            return;
          }

          // /chatid works in any chat (registered or not)
          if (text.trim() === '/chatid') {
            const groups = this.opts.registeredGroups();
            const isRegistered = jid in groups;
            const status = isRegistered ? 'registered' : 'not registered';
            await this.sendMessage(jid, `Chat ID: ${jid} (${status})`);
            return;
          }

          // Filter unregistered chats before routing to the agent
          const groups = this.opts.registeredGroups();
          if (!(jid in groups)) {
            logger.debug(
              { jid },
              'DeltaChat: ignoring message from unregistered chat',
            );
            return;
          }

          // React with 👀 to acknowledge receipt
          this.lastMsgId.set(jid, msgId);
          try {
            await dc.rpc.sendReaction(aid, msgId, ['👀']);
          } catch (err) {
            logger.warn(
              { err, msgId },
              'DeltaChat: failed to send 👀 reaction',
            );
          }

          // Build content: text or media placeholder
          let content: string;
          const viewType = msg.viewType ?? 'Unknown';
          if (viewType === 'Text' || viewType === 'Unknown') {
            if (!text) return; // truly empty message
            content = text;
          } else {
            content = mediaPlaceholder(viewType, msg.fileName ?? null, text);
          }

          this.opts.onMessage(jid, {
            id: String(msgId),
            chat_jid: jid,
            sender,
            sender_name: senderName,
            content,
            timestamp: new Date(msg.timestamp * 1000).toISOString(),
          });
        } catch (err) {
          logger.error(
            { err, chatId, msgId },
            'DeltaChat: failed to process IncomingMsg',
          );
        }
      },
    );

    this._connected = true;
    logger.info('DeltaChat channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = chatIdFromJid(jid);
    if (chatId === null || !this.dc || this.accountId === null) return;
    await this.dc.rpc.sendMsg(this.accountId, chatId, {
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
  }

  /** Update reaction on the last incoming message for this JID. */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const msgId = this.lastMsgId.get(jid);
    if (msgId === undefined || !this.dc || this.accountId === null) return;
    const emoji = isTyping ? '💭' : '✅';
    try {
      await this.dc.rpc.sendReaction(this.accountId, msgId, [emoji]);
    } catch (err) {
      logger.warn(
        { err, jid, emoji },
        'DeltaChat: failed to send typing reaction',
      );
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.dc && this.accountId !== null) {
      await this.dc.rpc.stopIo(this.accountId);
    }
    this._connected = false;
  }
}

registerChannel('deltachat', (opts) => {
  const env = readEnvFile([
    'DELTACHAT_CHATMAIL_QR',
    'DELTACHAT_ADDR',
    'DELTACHAT_MAIL_PW',
    'DELTACHAT_DATA_DIR',
  ]);

  const chatmailQr = env.DELTACHAT_CHATMAIL_QR;
  const addr = env.DELTACHAT_ADDR;
  const mailPw = env.DELTACHAT_MAIL_PW;

  if (!chatmailQr && !(addr && mailPw)) {
    return null; // not configured
  }

  const rawDataDir = env.DELTACHAT_DATA_DIR ?? 'store/deltachat';
  const dataDir = path.resolve(rawDataDir.replace(/^~/, HOME_DIR));

  return new DeltaChatChannel({
    chatmailQr,
    addr,
    mailPw,
    dataDir,
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
  });
});
