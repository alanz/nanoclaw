/**
 * WebXDC chat surface for the DeltaChat adapter: the parts that don't need
 * the RPC connection.
 *
 * An app instance (the message `/app` sent) is a thread of the chat it lives
 * in, `xdc:<msgId>`. Inbound updates from it reach the router with that
 * thread, so in a DM they land in the chat's one session and the agent's
 * replies, typing and question cards come back to the app by ordinary
 * routing — no app-specific tool, no msgId for the model to get wrong.
 *
 * Design and the pitfalls it avoids: ~/.hermes/TODO-deltachat.md §3–4 and
 * docs/webxdc-phase0.md (bot pushes reach an app that never pinged, and are
 * replayed when it reopens — so updates are pushed directly, no queue).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import type { NormalizedOption } from './ask-question.js';

export const XDC_THREAD_PREFIX = 'xdc:';

/**
 * The source of the chat surface app, zipped into `nanoclaw.xdc` on demand.
 * Read from the checkout (the host's working directory), not next to the
 * compiled module: the build copies no assets into dist/.
 */
export const APP_SOURCE_DIR = path.resolve(process.cwd(), 'src', 'channels', 'deltachat-webxdc-app');

export function xdcThread(msgId: number): string {
  return `${XDC_THREAD_PREFIX}${msgId}`;
}

/** The instance msgId of an `xdc:` thread, or null for any other thread. */
export function instanceOfThread(threadId: string | null | undefined): number | null {
  if (!threadId?.startsWith(XDC_THREAD_PREFIX)) return null;
  const n = Number(threadId.slice(XDC_THREAD_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Instance book ────────────────────────────────────────────────────────────

export interface InstanceRecord {
  msgId: number;
  platformId: string;
  app: string;
  createdAt: string;
  /** Highest status-update serial already read; updates after it are new. */
  lastSerial: number;
}

export interface AppQuestion {
  questionId: string;
  msgId: number;
  options: NormalizedOption[];
  title: string;
}

interface BookData {
  instances: InstanceRecord[];
  questions: AppQuestion[];
}

/**
 * The app instances this bot sent, and question cards pending in them.
 * Inbound updates from an instance not in the book are ignored: only apps the
 * bot sent can talk to it.
 */
export class WebxdcBook {
  private data: BookData = { instances: [], questions: [] };

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<BookData>;
      this.data = { instances: parsed.instances ?? [], questions: parsed.questions ?? [] };
    } catch {
      // no book yet
    }
  }

  addInstance(rec: InstanceRecord): void {
    this.data.instances = this.data.instances.filter((i) => i.msgId !== rec.msgId);
    this.data.instances.push(rec);
    this.save();
  }

  instance(msgId: number): InstanceRecord | undefined {
    return this.data.instances.find((i) => i.msgId === msgId);
  }

  setLastSerial(msgId: number, serial: number): void {
    const rec = this.instance(msgId);
    if (!rec || serial <= rec.lastSerial) return;
    rec.lastSerial = serial;
    this.save();
  }

  addQuestion(q: AppQuestion): void {
    this.data.questions = this.data.questions.filter((x) => x.questionId !== q.questionId);
    this.data.questions.push(q);
    this.save();
  }

  question(questionId: string): AppQuestion | undefined {
    return this.data.questions.find((q) => q.questionId === questionId);
  }

  removeQuestion(questionId: string): void {
    const before = this.data.questions.length;
    this.data.questions = this.data.questions.filter((q) => q.questionId !== questionId);
    if (this.data.questions.length !== before) this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf-8');
    } catch {
      // best effort: an unsaved book re-reads old updates after a restart
    }
  }
}

// ── Packaging ────────────────────────────────────────────────────────────────

/**
 * A ZIP archive of every regular file directly in `dir` (the .xdc format:
 * index.html at the root). Deflated, with no dependency beyond zlib.
 */
export function buildXdc(dir: string): Buffer {
  const names = fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith('.') && fs.statSync(path.join(dir, n)).isFile())
    .sort();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(dir, name));
    const packed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(0, 10); // time/date
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ── Bot → app payloads ───────────────────────────────────────────────────────

export interface AppComponent {
  id: string;
  type: 'button';
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
}

export type BotPayload =
  | { type: 'message'; id: string; title: string; content: string; timestamp: number }
  | {
      type: 'interactive';
      id: string;
      title: string;
      content: string;
      surfaceId: string;
      components: AppComponent[];
      timestamp: number;
    }
  | { type: 'resolved'; surfaceId: string; content: string }
  | { type: 'status'; text: string | null }
  | { type: 'mark'; id: string; mark: AppMark }
  | { type: 'meta'; msgId: number };

/**
 * The status of one message the user sent from the app, shown on its bubble:
 * the chat's 👀 → 💭 → ✅ reactions, for parity. Moves forward only.
 */
export type AppMark = '👀' | '💭' | '✅';
export const APP_MARKS: AppMark[] = ['👀', '💭', '✅'];

/** Payload types the bot sends. Updates of these types are the bot's own echo. */
const BOT_TYPES = new Set([
  'message',
  'interactive',
  'resolved',
  'status',
  'mark',
  'meta',
  'clear',
  'user_echo',
  'up_to_date',
]);

/** The status-update JSON for a payload: `notify` makes a phone notification for content. */
export function statusUpdate(payload: BotPayload, notifyName: string): string {
  const update: Record<string, unknown> = { payload };
  if (payload.type === 'message' || payload.type === 'interactive') {
    const gist = payload.content.replace(/\s+/g, ' ').trim();
    update.notify = { '*': `${notifyName}: ${gist.length > 80 ? gist.slice(0, 79) + '…' : gist}` };
  }
  return JSON.stringify(update);
}

export function questionPayload(
  id: string,
  title: string,
  question: string | undefined,
  questionId: string,
  options: NormalizedOption[],
): BotPayload {
  return {
    type: 'interactive',
    id,
    title,
    content: question ? `**${title}**\n\n${question}` : `**${title}**`,
    surfaceId: questionId,
    components: options.map((o, i) => ({
      id: o.value,
      type: 'button',
      label: o.label,
      style: i === 0 ? 'primary' : 'secondary',
    })),
    timestamp: Date.now(),
  };
}

const INLINE_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Images up to this size go into the app inline; anything else goes to the chat. */
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

/** Markdown showing a small image inline, or null when it belongs in the chat as an attachment. */
export function inlineImage(filename: string, data: Buffer): string | null {
  const mime = INLINE_IMAGE_TYPES[path.extname(filename).toLowerCase()];
  if (!mime || data.length > MAX_INLINE_IMAGE_BYTES) return null;
  const alt = filename.replace(/[[\]]/g, '');
  return `![${alt}](data:${mime};base64,${data.toString('base64')})`;
}

// ── App → bot updates ────────────────────────────────────────────────────────

export type AppUpdate =
  | { kind: 'message'; text: string; id: string | null }
  | { kind: 'action'; actionId: string; value: unknown; surfaceId: string | null }
  | { kind: 'ping' };

/**
 * What one status update from the app asks for, or null for anything else —
 * including the bot's own updates, which DeltaChat hands back as status
 * updates too (the echo).
 */
export function parseAppUpdate(payload: unknown): AppUpdate | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.type !== 'string' || BOT_TYPES.has(p.type)) return null;
  if (p.type === 'user_message' && typeof p.content === 'string' && p.content.trim()) {
    return { kind: 'message', text: p.content, id: typeof p.id === 'string' ? p.id : null };
  }
  if (p.type === 'action' && typeof p.actionId === 'string') {
    return {
      kind: 'action',
      actionId: p.actionId,
      value: p.value,
      surfaceId: typeof p.surfaceId === 'string' ? p.surfaceId : null,
    };
  }
  if (p.type === 'ping' || p.type === 'ready') return { kind: 'ping' };
  return null;
}

/** The text an action that answers no pending question becomes in the conversation. */
export function actionText(a: { actionId: string; value: unknown; surfaceId: string | null }): string {
  return `[Action: ${a.actionId} = ${JSON.stringify(a.value)}]${a.surfaceId ? ` (surface: ${a.surfaceId})` : ''}`;
}

/** Told to the agent with every message from the app. */
export const APP_SURFACE_NOTE =
  '[Sent from the NanoClaw app inside DeltaChat; your reply shows there, rendered as Markdown.]';
