import fs from 'fs';
import path from 'path';
import { startDeltaChat } from '@deltachat/stdio-rpc-server';
import type { DeltaChatOverJsonRpcServer } from '@deltachat/stdio-rpc-server';
import { registerChannel } from './registry.js';
import type { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';
import { readEnvFile } from '../env.js';
import { HOME_DIR } from '../config.js';
import { logger } from '../logger.js';

function jidForChat(chatId: number): string {
  return `dc:${chatId}`;
}

function chatIdFromJid(jid: string): number | null {
  const m = jid.match(/^dc:(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

class DeltaChatChannel implements Channel {
  name = 'deltachat';
  private dc: DeltaChatOverJsonRpcServer | null = null;
  private accountId: number | null = null;
  private _connected = false;

  constructor(
    private readonly chatmailQr: string | undefined,
    private readonly addr: string | undefined,
    private readonly mailPw: string | undefined,
    private readonly dataDir: string,
    private readonly onMessage: OnInboundMessage,
    private readonly onChatMetadata: OnChatMetadata,
  ) {}

  async connect(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });

    // DeltaChat RPC server requires accounts.toml to exist on startup
    const accountsToml = path.join(this.dataDir, 'accounts.toml');
    if (!fs.existsSync(accountsToml)) {
      fs.writeFileSync(
        accountsToml,
        'selected_account = 0\nnext_id = 1\naccounts = []\n',
        'utf8',
      );
    }

    this.dc = await startDeltaChat(this.dataDir);

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
      if (this.chatmailQr) {
        await this.dc.rpc.batchSetConfig(account.id, {
          bot: '1',
          e2ee_enabled: '1',
          displayname: 'NanoClaw',
        });
        await this.dc.rpc.setConfigFromQr(account.id, this.chatmailQr);
        await this.dc.rpc.configure(account.id);
      } else if (this.addr && this.mailPw) {
        await this.dc.rpc.batchSetConfig(account.id, {
          addr: this.addr,
          mail_pw: this.mailPw,
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
          if (!msg.text) return;

          const chat = await dc.rpc.getBasicChatInfo(aid, chatId);
          const contact = await dc.rpc.getContact(aid, msg.fromId);
          const isGroup = chat.chatType !== 100; // 100 = single/DM in DC

          const jid = jidForChat(chatId);
          const sender = contact.address ?? String(msg.fromId);
          const senderName = contact.displayName ?? sender;

          this.onChatMetadata(
            jid,
            new Date().toISOString(),
            chat.name,
            'deltachat',
            isGroup,
          );
          this.onMessage(jid, {
            id: String(msgId),
            chat_jid: jid,
            sender,
            sender_name: senderName,
            content: msg.text,
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

  return new DeltaChatChannel(
    chatmailQr,
    addr,
    mailPw,
    dataDir,
    opts.onMessage,
    opts.onChatMetadata,
  );
});
