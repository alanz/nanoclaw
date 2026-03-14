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
import { HOME_DIR, ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';

const AVATAR_SOURCE = path.resolve(
  DATA_DIR,
  '..',
  'assets',
  'nanoclaw-profile.jpeg',
);

/** Copy the NanoClaw avatar into the DC data directory and return its path, or null on failure. */
function copyAvatarToDataDir(dataDir: string): string | null {
  try {
    if (!fs.existsSync(AVATAR_SOURCE)) return null;
    const dest = path.join(dataDir, 'nanoclaw-avatar.jpeg');
    fs.copyFileSync(AVATAR_SOURCE, dest);
    return dest;
  } catch {
    return null;
  }
}

function jidForChat(chatId: number): string {
  return `dc:${chatId}`;
}

function chatIdFromJid(jid: string): number | null {
  const m = jid.match(/^dc:(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Format a non-text viewType as a readable placeholder with optional caption.
 * When containerPath is provided (the file was copied to the IPC attachments
 * directory), it is embedded in the label so the agent can read the file.
 */
function mediaPlaceholder(
  viewType: string,
  fileName: string | null,
  caption: string,
  containerPath?: string | null,
): string {
  let label: string;
  switch (viewType) {
    case 'Image':
      label = containerPath ? `[Image: ${containerPath}]` : '[Image]';
      break;
    case 'Gif':
      label = containerPath ? `[GIF: ${containerPath}]` : '[GIF]';
      break;
    case 'Video':
      label = containerPath ? `[Video: ${containerPath}]` : '[Video]';
      break;
    case 'File':
      label = containerPath
        ? `[File: ${containerPath}]`
        : fileName
          ? `[File: ${fileName}]`
          : '[File]';
      break;
    case 'Sticker':
      label = containerPath ? `[Sticker: ${containerPath}]` : '[Sticker]';
      break;
    case 'Audio':
      label = containerPath ? `[Audio: ${containerPath}]` : '[Audio]';
      break;
    case 'Voice':
      label = containerPath
        ? `[Voice message: ${containerPath}]`
        : '[Voice message]';
      break;
    case 'Vcard':
      label = containerPath
        ? `[Contact (vCard): ${containerPath}]`
        : '[Contact (vCard)]';
      break;
    case 'Webxdc':
      label = containerPath ? `[Webxdc app: ${containerPath}]` : '[Webxdc app]';
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

/** How long to wait for additional messages from the same sender before routing to the agent. */
const DEBOUNCE_MS = 1500;

/** How long to remember a delivered message ID for edit tracking. */
const EDIT_TRACK_TTL_MS = 60 * 60 * 1000; // 1 hour

type DebounceEntry = {
  msgIds: number[];
  parts: string[];
  sender: string;
  senderName: string;
  firstTimestamp: string;
};

export interface DeltaChatChannelOpts {
  chatmailQr: string | undefined;
  addr: string | undefined;
  mailPw: string | undefined;
  dataDir: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Called when a trusted group gains extra members — revokes trust and notifies. */
  onTrustedGroupViolation: (jid: string, memberCount: number) => void;
}

export class DeltaChatChannel implements Channel {
  name = 'deltachat';
  private dc: DeltaChatOverJsonRpcServer | null = null;
  private accountId: number | null = null;
  private _connected = false;
  /** Track the last incoming message ID per JID for reactions. */
  private lastMsgId = new Map<string, number>();
  /** Debounce state: accumulate rapid messages per JID before routing. */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceEntries = new Map<string, DebounceEntry>();
  /** Deduplicates IncomingMsg events; also checked by MsgsChanged to block double-delivery of edits. */
  private seenMsgIds = new Set<number>();
  /** Message IDs seen via IncomingMsg, kept for edit detection in MsgsChanged (1-hour window). */
  private processedMsgIds = new Set<number>();

  constructor(private readonly opts: DeltaChatChannelOpts) {}

  /**
   * Build the content string for a message, including quote prefix and
   * media placeholder. Returns null if the message has no deliverable content.
   */
  private buildContent(
    msg: any,
    msgId: number,
    groups: Record<string, RegisteredGroup>,
    jid: string,
  ): string | null {
    const text = msg.text ?? '';

    // Prepend quoted reply context if present
    let quotePrefix = '';
    if (msg.quote) {
      const q = msg.quote as
        | {
            kind: 'WithMessage';
            text: string;
            authorDisplayName?: string;
            messageId?: number;
          }
        | { kind: 'JustText'; text: string };
      if (q.kind === 'WithMessage' && q.text) {
        const author = q.authorDisplayName ? ` (${q.authorDisplayName})` : '';
        quotePrefix = `[Replying to${author}: "${q.text}"]\n`;
      } else if (q.kind === 'JustText' && q.text) {
        quotePrefix = `[Quoting: "${q.text}"]\n`;
      }
    }

    const viewType = msg.viewType ?? 'Unknown';
    if (viewType === 'Text' || viewType === 'Unknown') {
      if (!text && !quotePrefix) return null; // truly empty message
      return quotePrefix + text;
    }

    // Non-text: copy attachment to IPC dir if present
    let containerPath: string | null = null;
    if (msg.file) {
      try {
        const groupFolder = groups[jid].folder;
        const attachmentsDir = path.join(
          resolveGroupIpcPath(groupFolder),
          'attachments',
        );
        fs.mkdirSync(attachmentsDir, { recursive: true });
        const destName = `${msgId}-${path.basename(msg.file)}`;
        fs.copyFileSync(msg.file, path.join(attachmentsDir, destName));
        containerPath = `/workspace/ipc/attachments/${destName}`;
      } catch (err) {
        logger.warn(
          { err, msgId },
          'DeltaChat: failed to copy attachment to IPC dir',
        );
      }
    }
    return (
      quotePrefix +
      mediaPlaceholder(viewType, msg.fileName ?? null, text, containerPath)
    );
  }

  /** Flush a debounce entry: combine parts and deliver to the agent. */
  private flushDebounce(jid: string): void {
    const entry = this.debounceEntries.get(jid);
    if (!entry) return;
    this.debounceEntries.delete(jid);
    this.debounceTimers.delete(jid);

    const content = entry.parts.join('\n');
    const lastMsgId = entry.msgIds[entry.msgIds.length - 1];

    this.opts.onMessage(jid, {
      id: String(lastMsgId),
      chat_jid: jid,
      sender: entry.sender,
      sender_name: entry.senderName,
      content,
      timestamp: entry.firstTimestamp,
    });
  }

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

    // Set avatar on every startup so it's applied even if the image was added after initial config
    const avatarPath = copyAvatarToDataDir(dataDir);
    if (avatarPath) {
      await this.dc.rpc.batchSetConfig(account.id, { selfavatar: avatarPath });
      logger.debug('DeltaChat: avatar set');
    }

    await this.dc.rpc.startIo(account.id);

    // Listen for incoming messages
    const emitter = this.dc.getContextEvents(account.id);

    emitter.on(
      'IncomingMsg',
      async ({ chatId, msgId }: { chatId: number; msgId: number }) => {
        if (this.seenMsgIds.has(msgId)) return;
        this.seenMsgIds.add(msgId);
        setTimeout(() => this.seenMsgIds.delete(msgId), 60_000);
        // Track immediately for edit detection in MsgsChanged (1-hour window)
        this.processedMsgIds.add(msgId);
        setTimeout(() => this.processedMsgIds.delete(msgId), EDIT_TRACK_TTL_MS);

        try {
          const dc = this.dc!;
          const aid = this.accountId!;
          const msg = await dc.rpc.getMessage(aid, msgId);

          // Skip info/system messages
          if (msg.isInfo) return;
          // Skip autocrypt setup messages
          if (msg.isSetupmessage) return;
          // Skip messages sent by this account (DC fires IncomingMsg for the bot's
          // own group messages, which would overwrite lastMsgId and break ✅ reactions)
          if (msg.fromId === 1) return; // DC_CONTACT_ID_SELF = 1

          const chat = await dc.rpc.getBasicChatInfo(aid, chatId);
          const contact = await dc.rpc.getContact(aid, msg.fromId);
          const isGroup = chat.chatType !== 100; // 100 = single/DM in DC

          const jid = jidForChat(chatId);
          const sender = contact.address ?? String(msg.fromId);
          const senderName = contact.displayName ?? sender;

          // Always emit chat metadata (enables group discovery for unregistered chats)
          this.opts.onChatMetadata(
            jid,
            new Date().toISOString(),
            chat.name,
            'deltachat',
            isGroup,
          );

          const text = msg.text ?? '';

          // /ping works in any chat (registered or not)
          if (text.trim() === '/ping') {
            await this.sendMessage(jid, `${ASSISTANT_NAME} is online.`);
            return;
          }

          // /help works in any chat (registered or not)
          if (text.trim() === '/help') {
            await this.sendMessage(
              jid,
              "Available commands:\n/ping — check if Andy is online\n/chatid — show this chat's ID and registration status\n/esc [context] — interrupt the running agent and inject new context\n/compact — compact the conversation to free up context\n/help — show this message",
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

          // React with 👀 to acknowledge receipt; track for 💭/✅ reactions
          this.lastMsgId.set(jid, msgId);
          try {
            await dc.rpc.sendReaction(aid, msgId, ['👀']);
          } catch (err) {
            logger.warn(
              { err, msgId },
              'DeltaChat: failed to send 👀 reaction',
            );
          }

          const content = this.buildContent(msg, msgId, groups, jid);
          if (content === null) return;

          // Debounce: accumulate rapid messages and flush as one to the agent
          const existing = this.debounceEntries.get(jid);
          if (existing) {
            existing.msgIds.push(msgId);
            existing.parts.push(content);
            clearTimeout(this.debounceTimers.get(jid));
          } else {
            this.debounceEntries.set(jid, {
              msgIds: [msgId],
              parts: [content],
              sender,
              senderName,
              firstTimestamp: new Date(msg.timestamp * 1000).toISOString(),
            });
          }
          this.debounceTimers.set(
            jid,
            setTimeout(() => this.flushDebounce(jid), DEBOUNCE_MS),
          );
        } catch (err) {
          logger.error(
            { err, chatId, msgId },
            'DeltaChat: failed to process IncomingMsg',
          );
        }
      },
    );

    // Listen for message edits
    emitter.on(
      'MsgsChanged',
      async ({ chatId, msgId }: { chatId: number; msgId: number }) => {
        // msgId = 0 means "some message in this chat changed" — too vague to act on
        if (!msgId || !this.processedMsgIds.has(msgId)) return;

        try {
          const dc = this.dc!;
          const aid = this.accountId!;
          const msg = await dc.rpc.getMessage(aid, msgId);

          if (msg.isInfo || msg.isSetupmessage || msg.fromId === 1) return;

          const jid = jidForChat(chatId);
          const groups = this.opts.registeredGroups();
          if (!(jid in groups)) return;

          const contact = await dc.rpc.getContact(aid, msg.fromId);
          const sender = contact.address ?? String(msg.fromId);
          const senderName = contact.displayName ?? sender;

          const content = this.buildContent(msg, msgId, groups, jid);
          if (content === null) return;

          // Block IncomingMsg from double-delivering the same edit
          this.seenMsgIds.add(msgId);
          setTimeout(() => this.seenMsgIds.delete(msgId), 60_000);

          logger.debug({ jid, msgId }, 'DeltaChat: message edited');

          this.opts.onMessage(jid, {
            id: `edit-${msgId}`,
            chat_jid: jid,
            sender,
            sender_name: senderName,
            content: `[Message edited]\n${content}`,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          logger.error(
            { err, chatId, msgId },
            'DeltaChat: failed to process MsgsChanged',
          );
        }
      },
    );

    // Listen for reactions to the bot's own messages
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
          const dc = this.dc!;
          const aid = this.accountId!;

          const jid = jidForChat(chatId);
          const groups = this.opts.registeredGroups();
          if (!(jid in groups)) return;

          const contact = await dc.rpc.getContact(aid, contactId);
          const sender = contact.address ?? String(contactId);
          const senderName = contact.displayName ?? sender;

          logger.debug(
            { jid, sender, reaction, msgId },
            'DeltaChat: incoming reaction',
          );

          this.opts.onMessage(jid, {
            id: `reaction-${msgId}-${contactId}`,
            chat_jid: jid,
            sender,
            sender_name: senderName,
            content: `[Reaction: ${reaction}]`,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          logger.error(
            { err, chatId, contactId, msgId, reaction },
            'DeltaChat: failed to process IncomingReaction',
          );
        }
      },
    );

    // Revoke trusted_group status if members are added to a trusted group
    emitter.on('ChatModified', async ({ chatId }: { chatId: number }) => {
      const jid = jidForChat(chatId);
      const groups = this.opts.registeredGroups();
      const group = groups[jid];
      if (!group?.trustedGroup) return;

      try {
        const dc = this.dc!;
        const aid = this.accountId!;
        const members = await dc.rpc.getChatContacts(aid, chatId);
        // Expected: [DC_CONTACT_ID_SELF, owner] = 2 members
        if (members.length > 2) {
          logger.warn(
            { jid, memberCount: members.length },
            'DeltaChat: trusted group gained members — revoking trusted status',
          );
          this.opts.onTrustedGroupViolation(jid, members.length);
        }
      } catch (err) {
        logger.error(
          { err, chatId },
          'DeltaChat: failed to check members after ChatModified',
        );
      }
    });

    // Connectivity monitoring — debounce bursts, then log with status label
    let connectivityDebounce: ReturnType<typeof setTimeout> | null = null;
    let connectivityCount = 0;
    const CONNECTIVITY_DEBOUNCE_MS = 500;

    const logConnectivity = async () => {
      connectivityCount = 0;
      try {
        const level = await this.dc!.rpc.getConnectivity(this.accountId!);
        let label: string;
        if (level >= 4000) label = 'connected';
        else if (level >= 3000) label = 'working';
        else if (level >= 2000) label = 'connecting';
        else label = 'not connected';
        logger.info(`DeltaChat: connectivity changed (${label})`);
      } catch {
        logger.info('DeltaChat: connectivity changed');
      }
    };

    emitter.on('ConnectivityChanged', () => {
      connectivityCount++;
      if (connectivityDebounce) clearTimeout(connectivityDebounce);
      connectivityDebounce = setTimeout(
        logConnectivity,
        CONNECTIVITY_DEBOUNCE_MS,
      );
    });
    emitter.on('ImapConnected', () => {
      logger.info('DeltaChat: IMAP connected');
    });
    emitter.on('ImapInboxIdle', () => {
      logger.info('DeltaChat: IMAP inbox idle (ready for instant delivery)');
    });
    emitter.on('SmtpConnected', () => {
      logger.info('DeltaChat: SMTP connected');
    });

    this._connected = true;
    logger.info('DeltaChat channel connected');
  }

  async sendMessage(jid: string, text: string, sender?: string): Promise<void> {
    const chatId = chatIdFromJid(jid);
    if (chatId === null || !this.dc || this.accountId === null) return;
    await this.dc.rpc.sendMsg(this.accountId, chatId, {
      text,
      html: null,
      viewtype: null,
      file: null,
      filename: null,
      location: null,
      overrideSenderName: sender ?? null,
      quotedMessageId: null,
      quotedText: null,
    });
  }

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
    sender?: string,
  ): Promise<void> {
    const chatId = chatIdFromJid(jid);
    if (chatId === null || !this.dc || this.accountId === null) return;
    await this.dc.rpc.sendMsg(this.accountId, chatId, {
      text: caption ?? null,
      html: null,
      viewtype: null,
      file: filePath,
      filename: null,
      location: null,
      overrideSenderName: sender ?? null,
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
    onTrustedGroupViolation: opts.onTrustedGroupViolation,
  });
});
