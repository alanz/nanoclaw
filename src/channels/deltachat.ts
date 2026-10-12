/**
 * DeltaChat channel adapter (v2).
 *
 * Bridges NanoClaw with DeltaChat via the stdio-rpc-server.
 * Each DeltaChat chat is a platformId (`dc:{chatId}`), threadId is always null.
 *
 * Senders are identified by key fingerprint (`dc:fp:{hex}`), not address: with
 * multi-relay DeltaChat the address is just the latest relay. Contacts without
 * a key fall back to `dc:{address}`. See deltachat-identity.ts.
 *
 * Inbound: debounces rapid messages before routing, attaches 👀 on receipt.
 * Outbound: sends text/files, handles edit/reaction operations; sends ✅ on delivery.
 * Cards: DeltaChat has no buttons, so question cards are sent as numbered text
 * and answered by reply (deltachat-cards.ts); display cards are sent as text.
 * A `sender` on the content is shown as the message's sender name.
 * Typing: sends 💭 on the last incoming message for the platformId.
 * A reaction is a message to the chat, not an ephemeral indicator, so the
 * status reactions move one way per message — 👀 → 💭 → ✅ — each sent at
 * most once, and never over a reaction the agent chose itself. ✅ goes on
 * with the reply, or — for a turn that ends without one — when the host
 * sweep sees the agent finished the message (up to a minute later).
 * Progress: on a turn that runs past PROGRESS_AFTER_MS, a "⏳ Searching the
 * web…" message follows the status the typing refresh passes, edited at most
 * every PROGRESS_EDIT_MS, and is deleted for everyone when the reply arrives
 * or the turn ends.
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
import { registerInboundCompletedHook } from '../reconcile-session.js';
import { mergeUsersInto } from '../modules/permissions/db/users.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  AMBIGUOUS_REPLY_NOTICE,
  CardBook,
  matchReply,
  parseQuestionContent,
  renderAnswered,
  renderDisplayCard,
  renderQuestion,
} from './deltachat-cards.js';
import { resolveQuestionRender } from './question-render-registry.js';
import {
  fingerprintFromHandle,
  fingerprintHandle,
  parseContactFingerprint,
  parseRelays,
} from './deltachat-identity.js';

/**
 * Files larger than this reach the agent as a placeholder, not a file.
 * Chatmail relays cap a whole mail at about 30 MB, so in practice every
 * received file fits; the cap only guards against a relay that allows more.
 */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** How the agent is told what kind of file arrived (`[voice message: x.ogg — saved to …]`). */
function attachmentType(viewType: string): string {
  switch (viewType) {
    case 'Image':
      return 'image';
    case 'Gif':
      return 'gif';
    case 'Sticker':
      return 'sticker';
    case 'Video':
      return 'video';
    case 'Audio':
      return 'audio';
    case 'Voice':
      return 'voice message';
    case 'Vcard':
      return 'contact (vCard)';
    default:
      return 'file';
  }
}
/** A turn shows a progress message only once it has run this long. */
const PROGRESS_AFTER_MS = 15_000;
/** Each edit is a message to the chat, so the progress line changes at most this often. */
const PROGRESS_EDIT_MS = 10_000;

/** Status reactions on an incoming message, in the only order they move. */
const STATUS_STEPS = ['👀', '💭', '✅'];

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
  let removeCompletedHook: (() => void) | null = null;
  /** The progress message for each platformId's current turn (forMsgId = the incoming message). */
  const progress = new Map<
    string,
    { forMsgId: number; since: number; msgId?: number; text?: string; editedAt: number }
  >();

  /** Last incoming message ID per platformId — used for reactions. */
  const lastMsgId = new Map<string, number>();
  /** The reaction the bot last put on each platformId's last incoming message. */
  const shownReaction = new Map<string, { msgId: number; emoji: string }>();
  /** Debounce state: accumulate rapid messages per chat before routing. */
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const debounceEntries = new Map<string, DebounceEntry>();
  /** Dedup set for IncomingMsg (short window) and edit-detection set (1-hour window). */
  const seenMsgIds = new Set<number>();
  const processedMsgIds = new Set<number>();
  /** Question cards delivered to chats, for answering by reply. */
  let cards = new CardBook(null);
  /** Resolved sender handle per DeltaChat contact id, and fingerprint → contact id for openDM. */
  const senderByContact = new Map<number, { handle: string; name: string }>();
  const contactByFingerprint = new Map<string, number>();

  /**
   * Resolve a contact to its stable sender handle (`fp:<hex>` for key
   * contacts, else the address). The first time a fingerprint is seen, any
   * legacy address-keyed users for the key's relays are merged into it.
   */
  async function resolveSender(contactId: number): Promise<{ handle: string; name: string }> {
    const cached = senderByContact.get(contactId);
    if (cached) return cached;

    const contact = await dc!.rpc.getContact(accountId!, contactId);
    const address = contact.address ?? String(contactId);
    const name = contact.displayName ?? address;
    let handle = address;

    if (contact.isKeyContact) {
      const encInfo = await dc!.rpc.getContactEncryptionInfo(accountId!, contactId);
      const fingerprint = parseContactFingerprint(encInfo, address);
      if (fingerprint) {
        handle = fingerprintHandle(fingerprint);
        contactByFingerprint.set(fingerprint, contactId);
        const legacy = [...new Set([address.toLowerCase(), ...parseRelays(encInfo)])].map((a) => `dc:${a}`);
        const merged = await mergeUsersInto(
          { id: `dc:${handle}`, kind: 'deltachat', display_name: name, created_at: new Date().toISOString() },
          legacy,
        );
        if (merged.length > 0) log.info('DeltaChat: merged address users into key identity', { merged, handle });
      } else {
        log.warn('DeltaChat: key contact without a parseable fingerprint — using address', { contactId });
      }
    }

    const resolved = { handle, name };
    senderByContact.set(contactId, resolved);
    return resolved;
  }

  /** Find the contact id for a sender handle (fingerprint or address), or null. */
  async function findContact(handle: string): Promise<number | null> {
    const fingerprint = fingerprintFromHandle(handle);
    if (!fingerprint) return dc!.rpc.lookupContactIdByAddr(accountId!, handle);

    const known = contactByFingerprint.get(fingerprint);
    if (known !== undefined) return known;
    for (const id of await dc!.rpc.getContactIds(accountId!, 0, null)) {
      const contact = await dc!.rpc.getContact(accountId!, id);
      if (!contact.isKeyContact) continue;
      const encInfo = await dc!.rpc.getContactEncryptionInfo(accountId!, id);
      if (parseContactFingerprint(encInfo, contact.address) === fingerprint) {
        contactByFingerprint.set(fingerprint, id);
        return id;
      }
    }
    return null;
  }

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

  async function sendText(platformId: string, text: string, sender?: string): Promise<string | null> {
    const chatId = chatIdFromPlatformId(platformId);
    if (chatId === null || !dc || accountId === null) return null;
    const msgId = await dc.rpc.sendMsg(accountId, chatId, {
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
    return String(msgId);
  }

  /**
   * A reply that answers a question card: report the choice to the host and
   * mark the card answered. Returns true when the reply was consumed.
   */
  async function answerByReply(
    platformId: string,
    msgId: number,
    text: string,
    quotedMsgId: number | null,
    sender: string,
  ): Promise<boolean> {
    if (!dc || accountId === null || !channelSetup) return false;
    const match = await matchReply(cards, platformId, text, quotedMsgId, async (qid) =>
      Boolean(await resolveQuestionRender(qid)),
    );
    if (match.kind === 'none') return false;
    if (match.kind === 'ambiguous') {
      await sendText(platformId, AMBIGUOUS_REPLY_NOTICE);
      return true;
    }
    const { card, option } = match;
    const render = await resolveQuestionRender(card.questionId);
    if (!render?.deferResolution) {
      try {
        await dc.rpc.sendEditRequest(
          accountId,
          card.msgId,
          renderAnswered(`❓ ${card.title}`, option.selectedLabel, render?.question),
        );
      } catch (err) {
        log.warn('DeltaChat: failed to mark card answered', { err, msgId: card.msgId });
      }
    }
    try {
      await dc.rpc.sendReaction(accountId, msgId, ['✅']);
    } catch {
      // cosmetic
    }
    cards.remove(card.questionId);
    channelSetup.onAction(card.questionId, option.value, `dc:${sender}`, {
      messageId: String(card.msgId),
      platformId,
      threadId: null,
    });
    log.info('DeltaChat: question answered by reply', { questionId: card.questionId, platformId });
    return true;
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

  /**
   * Move the last incoming message's status reaction forward to `emoji`.
   * No-op when it is already there or further on, or when the reaction
   * showing is one the agent chose (not a status step).
   */
  async function advanceStatus(platformId: string, emoji: '💭' | '✅'): Promise<void> {
    const msgId = lastMsgId.get(platformId);
    if (msgId === undefined || !dc || accountId === null) return;
    const shown = shownReaction.get(platformId);
    if (shown?.msgId === msgId) {
      const at = STATUS_STEPS.indexOf(shown.emoji);
      if (at === -1 || at >= STATUS_STEPS.indexOf(emoji)) return;
    }
    // Recorded before the send so a concurrent refresh tick sees it.
    shownReaction.set(platformId, { msgId, emoji });
    try {
      await dc.rpc.sendReaction(accountId, msgId, [emoji]);
    } catch (err) {
      if (shown) shownReaction.set(platformId, shown);
      else shownReaction.delete(platformId);
      log.warn(`DeltaChat: failed to send ${emoji} reaction`, { err, platformId });
    }
  }

  /** Show what the agent is doing, once the turn has run long enough to be worth it. */
  async function showProgress(platformId: string, status: string): Promise<void> {
    const forMsgId = lastMsgId.get(platformId);
    if (forMsgId === undefined || !dc || accountId === null) return;
    const now = Date.now();
    let p = progress.get(platformId);
    if (!p || p.forMsgId !== forMsgId) {
      // A new incoming message starts a new turn; an older turn's line goes.
      if (p) await clearProgress(platformId);
      p = { forMsgId, since: now, editedAt: 0 };
      progress.set(platformId, p);
    }
    if (now - p.since < PROGRESS_AFTER_MS) return;
    const text = `⏳ ${status.charAt(0).toUpperCase()}${status.slice(1)}…`;
    if (p.msgId === undefined) {
      if (p.editedAt !== 0) return; // a send is already in flight
      p.editedAt = now;
      let sent: number;
      try {
        const id = await sendText(platformId, text);
        if (id === null) throw new Error('not connected');
        sent = Number(id);
      } catch (err) {
        p.editedAt = 0; // let the next tick try again
        log.warn('DeltaChat: failed to send progress message', { err, platformId });
        return;
      }
      if (progress.get(platformId) !== p) {
        // The reply overtook the send: the line is already stale.
        await deleteForAll([sent]);
        return;
      }
      p.msgId = sent;
      p.text = text;
    } else if (text !== p.text && now - p.editedAt >= PROGRESS_EDIT_MS) {
      p.text = text;
      p.editedAt = now;
      try {
        await dc.rpc.sendEditRequest(accountId, p.msgId, text);
      } catch (err) {
        log.warn('DeltaChat: failed to edit progress message', { err, platformId });
      }
    }
  }

  /**
   * Delete the turn's progress message. `restart` keeps the turn going (a
   * reply mid-turn): a new line may appear if the agent works on for long.
   */
  async function clearProgress(platformId: string, restart = false): Promise<void> {
    const p = progress.get(platformId);
    if (!p) return;
    if (restart) progress.set(platformId, { forMsgId: p.forMsgId, since: Date.now(), editedAt: 0 });
    else progress.delete(platformId);
    if (p.msgId !== undefined) await deleteForAll([p.msgId]);
  }

  async function deleteForAll(msgIds: number[]): Promise<void> {
    if (!dc || accountId === null || msgIds.some((id) => !Number.isFinite(id))) return;
    try {
      await dc.rpc.deleteMessagesForAll(accountId, msgIds);
    } catch (err) {
      log.warn('DeltaChat: failed to delete progress message', { err, msgIds });
    }
  }

  async function sendDoneReaction(platformId: string): Promise<void> {
    await advanceStatus(platformId, '✅');
  }

  const adapter: ChannelAdapter = {
    name: 'deltachat',
    channelType: 'deltachat',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      channelSetup = config;
      removeCompletedHook?.();
      removeCompletedHook = registerInboundCompletedHook(async (completed, session) => {
        for (const c of completed) {
          if (c.channelType !== 'deltachat' || !c.platformId) continue;
          // Inbound ids are `<platform msg id>:<agent group id>` (router).
          const suffix = `:${session.agent_group_id}`;
          if (!c.id.endsWith(suffix)) continue;
          const msgId = Number(c.id.slice(0, -suffix.length));
          if (lastMsgId.get(c.platformId) !== msgId) continue;
          await clearProgress(c.platformId);
          await advanceStatus(c.platformId, '✅');
        }
      });
      fs.mkdirSync(dataDir, { recursive: true });
      cards = new CardBook(path.join(dataDir, 'nanoclaw-cards.json'));

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
          const isGroup = chat.chatType !== 'Single';
          const platformId = platformIdForChat(chatId);
          const { handle: sender, name: senderName } = await resolveSender(msg.fromId);

          // One-shot first-contact record consumed by setup:auto to wire the owner.
          // Only written for DMs, only if the file doesn't already exist.
          if (!isGroup) {
            const firstContactPath = path.join(dataDir, 'first-contact');
            if (!fs.existsSync(firstContactPath)) {
              try {
                fs.writeFileSync(
                  firstContactPath,
                  JSON.stringify({
                    addr: (await dcRef.rpc.getContact(aid, msg.fromId)).address,
                    handle: sender,
                    chatId: String(chatId),
                    displayName: senderName,
                  }),
                  'utf8',
                );
              } catch {
                // non-fatal
              }
            }
          }

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

          // A text reply may be the answer to a question card
          const viewTypeIn = (msg.viewType as string | undefined) ?? 'Unknown';
          if (text && (viewTypeIn === 'Text' || viewTypeIn === 'Unknown')) {
            const quote = msg.quote as { kind: string; messageId?: number } | null;
            const quotedMsgId =
              quote?.kind === 'WithMessage' && typeof quote.messageId === 'number' ? quote.messageId : null;
            if (await answerByReply(platformId, msgId, text, quotedMsgId, sender)) return;
          }

          // React with 👀 to acknowledge receipt; track msgId for typing/done reactions
          lastMsgId.set(platformId, msgId);
          shownReaction.set(platformId, { msgId, emoji: '👀' });
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
                attachments.push({ data: data.toString('base64'), name: filename, type: attachmentType(viewType) });
                if (text) contentParts.push(text);
              } else {
                const mb = Math.round(stat.size / (1024 * 1024));
                contentParts.push(
                  `${mediaPlaceholder(viewType, (msg.fileName as string | null | undefined) ?? null, text)}\n` +
                    `(file not passed on: ${mb} MB is over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit)`,
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
          const { handle: sender, name: senderName } = await resolveSender(msg.fromId);
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
            const { handle: sender, name: senderName } = await resolveSender(contactId);
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
      removeCompletedHook?.();
      removeCompletedHook = null;
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
      // or an approval card's terminal state: { ..., terminalCard: { title, question, resolution } }
      if (content.operation === 'edit') {
        const rawId = content.messageId;
        const terminal = content.terminalCard as
          | { title?: unknown; question?: unknown; resolution?: unknown }
          | undefined;
        const text =
          terminal && typeof terminal.title === 'string' && typeof terminal.resolution === 'string'
            ? renderAnswered(
                terminal.title,
                terminal.resolution,
                typeof terminal.question === 'string' ? terminal.question : undefined,
              )
            : content.text;
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
              if (lastMsgId.get(platformId) === msgId) shownReaction.set(platformId, { msgId, emoji });
            } catch (err) {
              log.warn('DeltaChat: failed to send reaction', { err, platformId, msgId });
            }
          }
        }
        return undefined;
      }

      const sender = typeof content.sender === 'string' && content.sender ? content.sender : undefined;
      // The agent's own reply replaces its progress line; a message relayed
      // under another name (a specialist) does not — the agent is still working.
      if (!sender) await clearProgress(platformId, true);

      // Question card (ask_user_question, approvals): numbered text, answered by reply
      const question = parseQuestionContent(content);
      if (question) {
        const platformMsgId = await sendText(platformId, renderQuestion(question), sender);
        if (platformMsgId) {
          cards.add({
            msgId: parseInt(platformMsgId, 10),
            platformId,
            questionId: question.questionId,
            title: question.sender ? `${question.sender}: ${question.title}` : question.title,
            options: question.options,
            expiresAt: question.expiresAt ?? null,
            createdAt: new Date().toISOString(),
          });
        }
        return platformMsgId ?? undefined;
      }

      const text =
        typeof content.text === 'string' ? content.text : content.type === 'card' ? renderDisplayCard(content) : '';

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
      const platformMsgId = await sendText(platformId, text, sender);
      await sendDoneReaction(platformId);
      return platformMsgId ?? undefined;
    },

    /** Cold-DM target for a sender handle: the 1:1 chat with that contact. */
    async openDM(userHandle: string): Promise<string> {
      if (!dc || accountId === null) throw new Error('DeltaChat: not connected');
      const contactId = await findContact(userHandle);
      if (contactId === null) throw new Error('DeltaChat: no known contact for handle');
      return platformIdForChat(await dc.rpc.createChatByContactId(accountId, contactId));
    },

    async setTyping(platformId: string, _threadId: string | null, status?: string): Promise<void> {
      // The typing module re-fires this every few seconds while the agent
      // works; only the first call per message reaches the chat.
      await advanceStatus(platformId, '💭');
      if (status) await showProgress(platformId, status);
    },
  };

  return adapter;
}

registerChannelAdapter('deltachat', {
  factory: () => {
    const env = readEnvFile(['DELTACHAT_CHATMAIL_QR', 'DELTACHAT_ADDR', 'DELTACHAT_MAIL_PW', 'DELTACHAT_DATA_DIR']);

    const addr = env.DELTACHAT_ADDR;
    const mailPw = env.DELTACHAT_MAIL_PW;
    const chatmailQr = env.DELTACHAT_CHATMAIL_QR ?? 'dcaccount:https://nine.testrun.org/new';

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
