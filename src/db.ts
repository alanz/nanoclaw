import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  FailureKind,
  NewMessage,
  RegisteredGroup,
  RssFeed,
  ScheduledTask,
  SpecialistConversationSession,
  SpecialistConversationSessionStatus,
  SpecialistTask,
  SpecialistTaskStatus,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS rss_feeds (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      schedule_type TEXT NOT NULL DEFAULT 'interval',
      schedule_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      next_check TEXT,
      seen_guids TEXT NOT NULL DEFAULT '[]',
      interest TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rss_next_check ON rss_feeds(next_check);
    CREATE INDEX IF NOT EXISTS idx_rss_status ON rss_feeds(status);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS specialist_tasks (
      id TEXT PRIMARY KEY,
      specialist_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      requester_group TEXT,
      requester_task_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      chain_delegation_count INTEGER NOT NULL DEFAULT 1,
      ancestor_types TEXT NOT NULL DEFAULT '[]',
      is_last_same_type_dispatch INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      pending_sub_task_id TEXT,
      result TEXT,
      failure_kind TEXT,
      failure_detail TEXT,
      restart_attempt_count INTEGER NOT NULL DEFAULT 0,
      delegated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_specialist_tasks_status ON specialist_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_specialist_tasks_requester ON specialist_tasks(requester_task_id);

    CREATE TABLE IF NOT EXISTS specialist_conversation_sessions (
      task_id TEXT PRIMARY KEY REFERENCES specialist_tasks(id),
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }
  // Add trusted_group column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN trusted_group INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add dispatch_depth column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN dispatch_depth INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'deltachat', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add total_tokens column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN total_tokens INTEGER`);
  } catch {
    /* column already exists */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Add status column to rss_feeds if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE rss_feeds ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    );
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at, dispatch_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
    task.dispatch_depth ?? 0,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, total_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
    log.total_tokens ?? null,
  );
}

// --- Router state accessors ---

export function getAllRouterStateRows(): Array<{ key: string; value: string }> {
  return db
    .prepare('SELECT key, value FROM router_state ORDER BY key')
    .all() as Array<{ key: string; value: string }>;
}

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        trusted_group: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    trustedGroup: row.trusted_group === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, trusted_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.trustedGroup ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    trusted_group: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      trustedGroup: row.trusted_group === 1 ? true : undefined,
    };
  }
  return result;
}

export interface TranscriptMessage {
  id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  sender: string;
  content: string;
}

export interface TranscriptResult {
  messages: TranscriptMessage[];
  has_more: boolean;
  next_cursor: string | null;
}

export function queryTranscript({
  chatJid,
  from,
  to,
  limit = 50,
  afterCursor,
  includeBotMessages = false,
}: {
  chatJid: string;
  from?: string;
  to?: string;
  limit?: number;
  afterCursor?: string;
  /** Include bot-sent messages (is_bot_message=1) in results. Default false. */
  includeBotMessages?: boolean;
}): TranscriptResult {
  const effectiveLimit = Math.min(Math.max(1, limit), 200);

  const conditions: string[] = ['chat_jid = ?'];
  const params: (string | number)[] = [chatJid];

  if (!includeBotMessages) {
    conditions.push('is_bot_message = 0');
  }
  if (from) {
    conditions.push('timestamp >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('timestamp <= ?');
    params.push(to);
  }
  if (afterCursor) {
    const cursorRowid = parseInt(afterCursor, 10);
    if (!isNaN(cursorRowid)) {
      conditions.push('rowid > ?');
      params.push(cursorRowid);
    }
  }

  params.push(effectiveLimit + 1);

  const rows = db
    .prepare(
      `SELECT rowid, id, timestamp, is_from_me, sender_name, content
       FROM messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY rowid ASC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    rowid: number;
    id: string;
    timestamp: string;
    is_from_me: number;
    sender_name: string;
    content: string;
  }>;

  const has_more = rows.length > effectiveLimit;
  const slice = rows.slice(0, effectiveLimit);

  const messages: TranscriptMessage[] = slice.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    direction: row.is_from_me ? 'outbound' : 'inbound',
    sender: row.sender_name || '',
    content: row.content,
  }));

  const next_cursor = has_more ? String(slice[slice.length - 1].rowid) : null;

  return { messages, has_more, next_cursor };
}

export function getChatMessages(
  chatJid: string,
  limit: number = 200,
): Array<{
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}> {
  return db
    .prepare(
      `SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
        FROM messages WHERE chat_jid = ?
        ORDER BY timestamp DESC LIMIT ?
      ) ORDER BY timestamp`,
    )
    .all(chatJid, limit) as ReturnType<typeof getChatMessages>;
}

export function getTaskRunLogs(
  taskId: string,
  limit: number = 50,
): Array<TaskRunLog & { id: number }> {
  return db
    .prepare(
      `SELECT id, task_id, run_at, duration_ms, status, result, error, total_tokens
       FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as Array<TaskRunLog & { id: number }>;
}

// --- RSS feed accessors ---

export function createRssFeed(feed: RssFeed): void {
  db.prepare(
    `INSERT INTO rss_feeds (id, group_folder, chat_jid, url, title, schedule_type, schedule_value, status, next_check, seen_guids, interest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    feed.id,
    feed.group_folder,
    feed.chat_jid,
    feed.url,
    feed.title,
    feed.schedule_type,
    feed.schedule_value,
    feed.status,
    feed.next_check,
    feed.seen_guids,
    feed.interest,
    feed.created_at,
  );
}

export function updateRssFeed(
  id: string,
  updates: Partial<Pick<RssFeed, 'status' | 'next_check'>>,
): void {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.next_check !== undefined) {
    fields.push('next_check = ?');
    values.push(updates.next_check);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE rss_feeds SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getRssFeedById(id: string): RssFeed | undefined {
  return db.prepare('SELECT * FROM rss_feeds WHERE id = ?').get(id) as
    | RssFeed
    | undefined;
}

export function getAllRssFeeds(): RssFeed[] {
  return db
    .prepare('SELECT * FROM rss_feeds ORDER BY created_at DESC')
    .all() as RssFeed[];
}

export function getRssFeedsForGroup(groupFolder: string): RssFeed[] {
  return db
    .prepare(
      'SELECT * FROM rss_feeds WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as RssFeed[];
}

export function getDueRssFeeds(): RssFeed[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM rss_feeds WHERE status = 'active' AND next_check IS NOT NULL AND next_check <= ? ORDER BY next_check`,
    )
    .all(now) as RssFeed[];
}

export function updateRssFeedAfterCheck(
  id: string,
  seenGuids: string,
  nextCheck: string,
  title?: string,
): void {
  if (title !== undefined) {
    db.prepare(
      `UPDATE rss_feeds SET seen_guids = ?, next_check = ?, title = ? WHERE id = ?`,
    ).run(seenGuids, nextCheck, title, id);
  } else {
    db.prepare(
      `UPDATE rss_feeds SET seen_guids = ?, next_check = ? WHERE id = ?`,
    ).run(seenGuids, nextCheck, id);
  }
}

export function deleteRssFeed(id: string): void {
  db.prepare('DELETE FROM rss_feeds WHERE id = ?').run(id);
}

// --- Specialist task accessors ---

export function createSpecialistTask(
  task: Omit<SpecialistTask, 'is_last_same_type_dispatch'> & {
    is_last_same_type_dispatch?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO specialist_tasks
       (id, specialist_type, prompt, requester_group, requester_task_id,
        depth, chain_delegation_count, ancestor_types, is_last_same_type_dispatch,
        status, pending_sub_task_id, result, failure_kind, failure_detail,
        restart_attempt_count, delegated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.specialist_type,
    task.prompt,
    task.requester_group ?? null,
    task.requester_task_id ?? null,
    task.depth,
    task.chain_delegation_count,
    task.ancestor_types,
    task.is_last_same_type_dispatch ? 1 : 0,
    task.status,
    task.pending_sub_task_id ?? null,
    task.result ?? null,
    task.failure_kind ?? null,
    task.failure_detail ?? null,
    task.restart_attempt_count,
    task.delegated_at,
    task.closed_at ?? null,
  );
}

export function getSpecialistTask(id: string): SpecialistTask | undefined {
  return db.prepare('SELECT * FROM specialist_tasks WHERE id = ?').get(id) as
    | SpecialistTask
    | undefined;
}

export function updateSpecialistTask(
  id: string,
  updates: Partial<
    Pick<
      SpecialistTask,
      | 'status'
      | 'pending_sub_task_id'
      | 'result'
      | 'failure_kind'
      | 'failure_detail'
      | 'restart_attempt_count'
      | 'closed_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if ('pending_sub_task_id' in updates) {
    fields.push('pending_sub_task_id = ?');
    values.push(updates.pending_sub_task_id ?? null);
  }
  if ('result' in updates) {
    fields.push('result = ?');
    values.push(updates.result ?? null);
  }
  if ('failure_kind' in updates) {
    fields.push('failure_kind = ?');
    values.push(updates.failure_kind ?? null);
  }
  if ('failure_detail' in updates) {
    fields.push('failure_detail = ?');
    values.push(updates.failure_detail ?? null);
  }
  if (updates.restart_attempt_count !== undefined) {
    fields.push('restart_attempt_count = ?');
    values.push(updates.restart_attempt_count);
  }
  if ('closed_at' in updates) {
    fields.push('closed_at = ?');
    values.push(updates.closed_at ?? null);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE specialist_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function getSpecialistTasksByStatus(
  status: SpecialistTaskStatus,
): SpecialistTask[] {
  return db
    .prepare(
      'SELECT * FROM specialist_tasks WHERE status = ? ORDER BY delegated_at',
    )
    .all(status) as SpecialistTask[];
}

export function getSpecialistSubTasks(parentTaskId: string): SpecialistTask[] {
  return db
    .prepare(
      'SELECT * FROM specialist_tasks WHERE requester_task_id = ? ORDER BY delegated_at',
    )
    .all(parentTaskId) as SpecialistTask[];
}

// --- Specialist conversation session accessors ---

export function createSpecialistSession(
  session: SpecialistConversationSession,
): void {
  db.prepare(
    `INSERT INTO specialist_conversation_sessions (task_id, session_id, status)
     VALUES (?, ?, ?)`,
  ).run(session.task_id, session.session_id, session.status);
}

export function getSpecialistSession(
  taskId: string,
): SpecialistConversationSession | undefined {
  return db
    .prepare('SELECT * FROM specialist_conversation_sessions WHERE task_id = ?')
    .get(taskId) as SpecialistConversationSession | undefined;
}

export function updateSpecialistSession(
  taskId: string,
  updates: Partial<
    Pick<SpecialistConversationSession, 'session_id' | 'status'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.session_id !== undefined) {
    fields.push('session_id = ?');
    values.push(updates.session_id);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;
  values.push(taskId);
  db.prepare(
    `UPDATE specialist_conversation_sessions SET ${fields.join(', ')} WHERE task_id = ?`,
  ).run(...values);
}

// --- Database explorer ---

export function getDbTables(): Array<{ name: string; count: number }> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return tables.map(({ name }) => {
    const row = db.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get() as {
      count: number;
    };
    return { name, count: row.count };
  });
}

export function getDbTableData(
  tableName: string,
  limit: number,
  offset: number,
  search?: string,
): { columns: string[]; rows: Record<string, unknown>[]; total: number } {
  const valid = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName) as { name: string } | undefined;
  if (!valid) return { columns: [], rows: [], total: 0 };

  const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
    name: string;
    type: string;
  }>;
  const columns = cols.map((c) => c.name);

  const trimmedSearch = search?.trim();
  if (trimmedSearch) {
    const textCols = cols.filter(
      (c) =>
        !['INTEGER', 'REAL', 'NUMERIC', 'BOOLEAN'].includes(
          c.type.toUpperCase(),
        ),
    );
    if (textCols.length > 0) {
      const like = `%${trimmedSearch}%`;
      const whereClause = textCols
        .map((c) => `"${c.name}" LIKE ?`)
        .join(' OR ');
      const bindParams: unknown[] = textCols.map(() => like);
      const total = (
        db
          .prepare(
            `SELECT COUNT(*) as count FROM "${tableName}" WHERE ${whereClause}`,
          )
          .get(bindParams) as { count: number }
      ).count;
      const rows = db
        .prepare(
          `SELECT * FROM "${tableName}" WHERE ${whereClause} LIMIT ? OFFSET ?`,
        )
        .all([...bindParams, limit, offset]) as Record<string, unknown>[];
      return { columns, rows, total };
    }
  }

  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as {
      count: number;
    }
  ).count;
  const rows = db
    .prepare(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`)
    .all(limit, offset) as Record<string, unknown>[];
  return { columns, rows, total };
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
