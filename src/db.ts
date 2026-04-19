import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  ContainerTransfer,
  ContainerTransferStatus,
  FailureKind,
  NewMessage,
  RawMemorySubmission,
  RawMemorySubmissionStatus,
  RegisteredGroup,
  RssFeed,
  ScheduledTask,
  SpecialistConversationSession,
  SpecialistConversationSessionStatus,
  SpecialistTask,
  SpecialistTaskStatus,
  TaskRunLog,
  TransferFile,
  TransferFileStatus,
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

    CREATE TABLE IF NOT EXISTS raw_memory_submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES specialist_tasks(id),
      topic TEXT NOT NULL,
      staging_path TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      accepted_at TEXT,
      final_path TEXT,
      status TEXT NOT NULL DEFAULT 'staged'
    );
    CREATE INDEX IF NOT EXISTS idx_raw_memory_status ON raw_memory_submissions(status);
    CREATE INDEX IF NOT EXISTS idx_raw_memory_task ON raw_memory_submissions(task_id);

    CREATE TABLE IF NOT EXISTS specialist_conversation_sessions (
      task_id TEXT PRIMARY KEY REFERENCES specialist_tasks(id),
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS container_transfers (
      id TEXT PRIMARY KEY,
      sender_invocation_id TEXT NOT NULL,
      sender_group_folder TEXT NOT NULL,
      message TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      recipient_task_id TEXT,
      recipient_group_folder TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_container_transfers_status ON container_transfers(status);
    CREATE INDEX IF NOT EXISTS idx_container_transfers_task ON container_transfers(recipient_task_id);

    CREATE TABLE IF NOT EXISTS transfer_files (
      id TEXT PRIMARY KEY,
      transfer_id TEXT NOT NULL REFERENCES container_transfers(id),
      original_name TEXT NOT NULL,
      host_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'owned'
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_files_transfer ON transfer_files(transfer_id);
    CREATE INDEX IF NOT EXISTS idx_transfer_files_status ON transfer_files(status);

    CREATE TABLE IF NOT EXISTS throwaway_sessions (
      id TEXT PRIMARY KEY,
      for_session_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      ephemeral_group_id TEXT NOT NULL,
      log_path TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      failure_signals TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL,
      was_manual_retry INTEGER NOT NULL DEFAULT 0,
      trigger_type TEXT NOT NULL DEFAULT 'compact'
    );
    CREATE INDEX IF NOT EXISTS idx_throwaway_for_session ON throwaway_sessions(for_session_id);
    CREATE INDEX IF NOT EXISTS idx_throwaway_status ON throwaway_sessions(status);
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
  // Create idx_rss_status after ensuring the status column exists
  try {
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_rss_status ON rss_feeds(status)`,
    );
  } catch {
    /* index already exists */
  }

  // Add overdue_alerted_at column to raw_memory_submissions if it doesn't exist
  try {
    database.exec(
      `ALTER TABLE raw_memory_submissions ADD COLUMN overdue_alerted_at TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add pending_dispatch_depth column to registered_groups if it doesn't exist
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN pending_dispatch_depth INTEGER`,
    );
  } catch {
    /* column already exists */
  }

  // Add task_type column to scheduled_tasks if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'prompt'`,
    );
  } catch {
    /* column already exists */
  }

  // Add min_idle_minutes column to scheduled_tasks if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN min_idle_minutes INTEGER`,
    );
  } catch {
    /* column already exists */
  }

  // Add was_manual_retry and trigger_type columns to throwaway_sessions if they don't exist
  try {
    database.exec(
      `ALTER TABLE throwaway_sessions ADD COLUMN was_manual_retry INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE throwaway_sessions ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'compact'`,
    );
  } catch {
    /* column already exists */
  }
  // Add source_input column so retry/recovery dispatch can reference the specific
  // ConversationArchive (or JSONL) this throwaway was created to summarise, rather
  // than re-scanning all archives for the session and picking the wrong one.
  try {
    database.exec(
      `ALTER TABLE throwaway_sessions ADD COLUMN source_input TEXT NOT NULL DEFAULT ''`,
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
 * Get the last_message_time for a specific chat JID, or null if unknown.
 */
export function getChatActivity(jid: string): string | null {
  const row = db
    .prepare('SELECT last_message_time FROM chats WHERE jid = ?')
    .get(jid) as { last_message_time: string } | undefined;
  return row?.last_message_time ?? null;
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
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at, dispatch_depth, task_type, min_idle_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    task.task_type ?? 'prompt',
    task.min_idle_minutes ?? null,
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

export function getClaimedTasks(): ScheduledTask[] {
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE last_result = 'claimed'
    AND (status = 'active' OR (status = 'completed' AND schedule_type = 'once'))
  `,
    )
    .all() as ScheduledTask[];
}

export function resetTaskForRecovery(id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET status = 'active', next_run = ?, last_result = 'recovering'
    WHERE id = ?
  `,
  ).run(now, id);
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
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, trusted_group, pending_dispatch_depth)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    group.pendingDispatchDepth ?? null,
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
    pending_dispatch_depth: number | null;
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
      pendingDispatchDepth:
        row.pending_dispatch_depth != null
          ? row.pending_dispatch_depth
          : undefined,
    };
  }
  return result;
}

/** Persist (or clear) pending_dispatch_depth for a registered group. */
export function setPendingDispatchDepthDb(
  jid: string,
  depth: number | null,
): void {
  db.prepare(
    `UPDATE registered_groups SET pending_dispatch_depth = ? WHERE jid = ?`,
  ).run(depth, jid);
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

export function getLiveSpecialistTasks(): SpecialistTask[] {
  return db
    .prepare(
      "SELECT * FROM specialist_tasks WHERE status IN ('queued', 'running', 'awaiting_sub_task', 'awaiting_restart') ORDER BY delegated_at",
    )
    .all() as SpecialistTask[];
}

export function getSpecialistSubTasks(parentTaskId: string): SpecialistTask[] {
  return db
    .prepare(
      'SELECT * FROM specialist_tasks WHERE requester_task_id = ? ORDER BY delegated_at',
    )
    .all(parentTaskId) as SpecialistTask[];
}

export function getRecentFinishedSpecialistTasks(
  limit: number,
): SpecialistTask[] {
  return db
    .prepare(
      "SELECT * FROM specialist_tasks WHERE status IN ('completed','failed') ORDER BY closed_at DESC LIMIT ?",
    )
    .all(limit) as SpecialistTask[];
}

export function getSpecialistSessionsForTasks(
  taskIds: string[],
): Record<string, SpecialistConversationSession> {
  if (taskIds.length === 0) return {};
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM specialist_conversation_sessions WHERE task_id IN (${placeholders})`,
    )
    .all(...taskIds) as SpecialistConversationSession[];
  return Object.fromEntries(rows.map((r) => [r.task_id, r]));
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

// --- Raw memory submission accessors ---

export function createRawMemorySubmission(
  submission: RawMemorySubmission,
): void {
  db.prepare(
    `INSERT INTO raw_memory_submissions
       (id, task_id, topic, staging_path, submitted_at, accepted_at, final_path, status, overdue_alerted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    submission.id,
    submission.task_id,
    submission.topic,
    submission.staging_path,
    submission.submitted_at,
    submission.accepted_at ?? null,
    submission.final_path ?? null,
    submission.status,
    submission.overdue_alerted_at ?? null,
  );
}

export function getRawMemorySubmission(
  id: string,
): RawMemorySubmission | undefined {
  return db
    .prepare('SELECT * FROM raw_memory_submissions WHERE id = ?')
    .get(id) as RawMemorySubmission | undefined;
}

export function updateRawMemorySubmission(
  id: string,
  updates: Partial<
    Pick<RawMemorySubmission, 'status' | 'accepted_at' | 'final_path'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if ('accepted_at' in updates) {
    fields.push('accepted_at = ?');
    values.push(updates.accepted_at ?? null);
  }
  if ('final_path' in updates) {
    fields.push('final_path = ?');
    values.push(updates.final_path ?? null);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE raw_memory_submissions SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function getRawMemorySubmissionsByStatus(
  status: RawMemorySubmissionStatus,
): RawMemorySubmission[] {
  return db
    .prepare(
      'SELECT * FROM raw_memory_submissions WHERE status = ? ORDER BY submitted_at',
    )
    .all(status) as RawMemorySubmission[];
}

export function getStagedMemorySubmissionsWithFolder(): (RawMemorySubmission & {
  group_folder: string | null;
})[] {
  return db
    .prepare(
      `SELECT rms.*, rg.folder AS group_folder
       FROM raw_memory_submissions rms
       LEFT JOIN specialist_tasks st ON rms.task_id = st.id
       LEFT JOIN registered_groups rg ON st.requester_group = rg.jid
       WHERE rms.status = 'staged'
       ORDER BY rms.submitted_at`,
    )
    .all() as (RawMemorySubmission & { group_folder: string | null })[];
}

export function getRecentAcceptedMemorySubmissions(
  limit: number,
): (RawMemorySubmission & { group_folder: string | null })[] {
  return db
    .prepare(
      `SELECT rms.*, rg.folder AS group_folder
       FROM raw_memory_submissions rms
       LEFT JOIN specialist_tasks st ON rms.task_id = st.id
       LEFT JOIN registered_groups rg ON st.requester_group = rg.jid
       WHERE rms.status = 'accepted'
       ORDER BY rms.accepted_at DESC
       LIMIT ?`,
    )
    .all(limit) as (RawMemorySubmission & { group_folder: string | null })[];
}

export function getMemorySubmissionsForTasks(
  taskIds: string[],
): (RawMemorySubmission & { group_folder: string | null })[] {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT rms.*, rg.folder AS group_folder
       FROM raw_memory_submissions rms
       LEFT JOIN specialist_tasks st ON rms.task_id = st.id
       LEFT JOIN registered_groups rg ON st.requester_group = rg.jid
       WHERE rms.task_id IN (${placeholders})
       ORDER BY rms.submitted_at`,
    )
    .all(...taskIds) as (RawMemorySubmission & {
    group_folder: string | null;
  })[];
}

export function markRawMemorySubmissionOverdueAlerted(
  id: string,
  alertedAt: string,
): void {
  db.prepare(
    `UPDATE raw_memory_submissions SET overdue_alerted_at = ? WHERE id = ?`,
  ).run(alertedAt, id);
}

// --- Note provenance ---

/**
 * Find researcher tasks closed on a given date (YYYY-MM-DD).
 * Used to link memory notes to their originating research task via the
 * report path date embedded in the note's sources frontmatter.
 */
export function getResearcherTaskIdsByDate(date: string): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM specialist_tasks
         WHERE specialist_type = 'researcher'
         AND DATE(closed_at) = ?`,
      )
      .all(date) as { id: string }[]
  ).map((r) => r.id);
}

// --- Specialist dispatch count query ---

const POLICY_REJECTION_KINDS = [
  'cycle_detected',
  'depth_exceeded',
  'count_exceeded',
  'same_type_limit_exceeded',
];

/**
 * Count prior dispatches from parentTaskId to targetTypeName, excluding tasks that
 * failed due to a policy rejection (those never consumed a real dispatch slot).
 * Non-policy failures (timeout, execution_error, host_restart) DO count.
 */
export function getSameTypeDispatchCount(
  parentTaskId: string,
  targetTypeName: string,
): number {
  const placeholders = POLICY_REJECTION_KINDS.map(() => '?').join(', ');
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM specialist_tasks
       WHERE requester_task_id = ?
         AND specialist_type = ?
         AND NOT (status = 'failed' AND failure_kind IN (${placeholders}))`,
    )
    .get(parentTaskId, targetTypeName, ...POLICY_REJECTION_KINDS) as {
    count: number;
  };
  return row.count;
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

// --- Container transfer accessors ---

export function createContainerTransfer(transfer: ContainerTransfer): void {
  db.prepare(
    `INSERT INTO container_transfers
       (id, sender_invocation_id, sender_group_folder, message, file_count,
        sent_at, status, recipient_task_id, recipient_group_folder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transfer.id,
    transfer.sender_invocation_id,
    transfer.sender_group_folder,
    transfer.message,
    transfer.file_count,
    transfer.sent_at,
    transfer.status,
    transfer.recipient_task_id ?? null,
    transfer.recipient_group_folder ?? null,
  );
}

export function getContainerTransfer(
  id: string,
): ContainerTransfer | undefined {
  return db
    .prepare('SELECT * FROM container_transfers WHERE id = ?')
    .get(id) as ContainerTransfer | undefined;
}

export function getTransfersByRecipientTask(
  taskId: string,
): ContainerTransfer[] {
  return db
    .prepare(
      `SELECT * FROM container_transfers
       WHERE recipient_task_id = ? AND status IN ('pending', 'in_transit')`,
    )
    .all(taskId) as ContainerTransfer[];
}

export function updateContainerTransfer(
  id: string,
  updates: Partial<
    Pick<
      ContainerTransfer,
      'status' | 'recipient_task_id' | 'recipient_group_folder'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if ('recipient_task_id' in updates) {
    fields.push('recipient_task_id = ?');
    values.push(updates.recipient_task_id ?? null);
  }
  if ('recipient_group_folder' in updates) {
    fields.push('recipient_group_folder = ?');
    values.push(updates.recipient_group_folder ?? null);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(
    `UPDATE container_transfers SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function createTransferFile(file: TransferFile): void {
  db.prepare(
    `INSERT INTO transfer_files (id, transfer_id, original_name, host_path, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    file.id,
    file.transfer_id,
    file.original_name,
    file.host_path,
    file.status,
  );
}

export function getTransferFilesByTransfer(transferId: string): TransferFile[] {
  return db
    .prepare('SELECT * FROM transfer_files WHERE transfer_id = ?')
    .all(transferId) as TransferFile[];
}

export function updateTransferFile(
  id: string,
  updates: Partial<Pick<TransferFile, 'status' | 'host_path'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.host_path !== undefined) {
    fields.push('host_path = ?');
    values.push(updates.host_path);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE transfer_files SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

/**
 * Mark all in_transit transfers for a specialist task as expired,
 * along with their associated files.  Called when a task reaches a
 * terminal state (completed or failed).
 */
export function expireTransfersForTask(taskId: string): void {
  const expiredStatus: ContainerTransferStatus = 'expired';
  const expiredFileStatus: TransferFileStatus = 'expired';
  const inTransit: ContainerTransferStatus = 'in_transit';

  // Find all in_transit transfers for this task
  const transfers = db
    .prepare(
      `SELECT id FROM container_transfers
       WHERE recipient_task_id = ? AND status = ?`,
    )
    .all(taskId, inTransit) as Array<{ id: string }>;

  for (const { id } of transfers) {
    db.prepare(
      `UPDATE transfer_files SET status = ? WHERE transfer_id = ?`,
    ).run(expiredFileStatus, id);
  }

  db.prepare(
    `UPDATE container_transfers SET status = ? WHERE recipient_task_id = ? AND status = ?`,
  ).run(expiredStatus, taskId, inTransit);
}

// ---------------------------------------------------------------------------
// ThrowawaySession
// ---------------------------------------------------------------------------

export type ThrowawaySessionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface ThrowawaySessionRecord {
  id: string;
  for_session_id: string;
  group_folder: string;
  chat_jid: string;
  ephemeral_group_id: string;
  log_path: string | null;
  retry_count: number;
  failure_signals: string | null; // JSON-encoded ThrowawayFailureSignals
  status: ThrowawaySessionStatus;
  started_at: string;
  was_manual_retry: number; // 0 = false, 1 = true
  trigger_type: 'compact' | 'reset';
  // Host filesystem path of the ConversationArchive (.md) or raw JSONL this throwaway
  // was created to summarise. Stable across retries so archive_datetime resolution
  // always references the original archive, not the most recent one for the session.
  source_input: string;
}

export function insertThrowawaySession(row: ThrowawaySessionRecord): void {
  db.prepare(
    `INSERT INTO throwaway_sessions
       (id, for_session_id, group_folder, chat_jid, ephemeral_group_id,
        log_path, retry_count, failure_signals, status, started_at,
        was_manual_retry, trigger_type, source_input)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.for_session_id,
    row.group_folder,
    row.chat_jid,
    row.ephemeral_group_id,
    row.log_path,
    row.retry_count,
    row.failure_signals,
    row.status,
    row.started_at,
    row.was_manual_retry,
    row.trigger_type,
    row.source_input,
  );
}

export function getThrowawaySessionById(
  id: string,
): ThrowawaySessionRecord | undefined {
  return db.prepare(`SELECT * FROM throwaway_sessions WHERE id = ?`).get(id) as
    | ThrowawaySessionRecord
    | undefined;
}

export function getThrowawaySessionByForSessionId(
  forSessionId: string,
): ThrowawaySessionRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM throwaway_sessions
       WHERE for_session_id = ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(forSessionId) as ThrowawaySessionRecord | undefined;
}

export function getThrowawaySessionsByStatus(
  ...statuses: ThrowawaySessionStatus[]
): ThrowawaySessionRecord[] {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT * FROM throwaway_sessions
       WHERE status IN (${placeholders})
       ORDER BY started_at ASC`,
    )
    .all(...statuses) as ThrowawaySessionRecord[];
}

export function getFailedThrowawaySessionsByGroup(
  groupFolder: string,
): ThrowawaySessionRecord[] {
  return db
    .prepare(
      `SELECT * FROM throwaway_sessions
       WHERE status = 'failed' AND group_folder = ?
       ORDER BY started_at ASC`,
    )
    .all(groupFolder) as ThrowawaySessionRecord[];
}

export function updateThrowawaySession(
  id: string,
  updates: Partial<
    Pick<
      ThrowawaySessionRecord,
      | 'status'
      | 'log_path'
      | 'retry_count'
      | 'failure_signals'
      | 'started_at'
      | 'was_manual_retry'
    >
  >,
): void {
  const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const fields = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE throwaway_sessions SET ${fields} WHERE id = ?`).run(
    ...values,
    id,
  );
}
