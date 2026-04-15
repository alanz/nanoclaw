export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  trustedGroup?: boolean; // Session commands allowed from any sender (like isMain, but isolated workspace)
  pendingDispatchDepth?: number; // Persisted dispatch depth to assign the next agent run (set by deliver_result)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  created_at: string;
  dispatch_depth?: number;
  /** 'session_reset' writes an IPC archive task and clears the session without spawning an agent.
   *  'user_profile' spawns an isolated agent to synthesise memory/USER.md from available sources. */
  task_type?: 'prompt' | 'session_reset' | 'user_profile';
  /** For session_reset tasks: skip if the chat has been active within this many minutes. */
  min_idle_minutes?: number | null;
}

export interface RssFeed {
  id: string;
  group_folder: string;
  chat_jid: string;
  url: string;
  title: string | null;
  schedule_type: 'interval' | 'cron';
  schedule_value: string;
  status: 'active' | 'paused' | 'cancelled';
  next_check: string | null;
  seen_guids: string; // JSON array, capped at 500
  interest: string | null;
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error' | 'skipped';
  result: string | null;
  error: string | null;
  total_tokens?: number;
}

// --- Specialist types ---

export interface SpecialistType {
  name: string;
  description: string;
  isMemoryProvider: boolean;
  lastTurnSubNotice?: string;
  lastTurnParentNotice?: string;
}

// --- Specialist task types ---

export type SpecialistTaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_sub_task'
  | 'awaiting_restart'
  | 'completed'
  | 'failed';

export type FailureKind =
  | 'cycle_detected'
  | 'depth_exceeded'
  | 'count_exceeded'
  | 'same_type_limit_exceeded'
  | 'timeout'
  | 'execution_error'
  | 'host_restart';

export type SpecialistConversationSessionStatus =
  | 'active'
  | 'stale'
  | 'cleared';

export interface SpecialistTask {
  id: string;
  specialist_type: string;
  prompt: string;
  requester_group: string | null;
  requester_task_id: string | null;
  depth: number;
  chain_delegation_count: number;
  ancestor_types: string; // JSON array of specialist type names
  is_last_same_type_dispatch: number; // SQLite boolean (0|1)
  status: SpecialistTaskStatus;
  pending_sub_task_id: string | null;
  result: string | null;
  failure_kind: FailureKind | null;
  failure_detail: string | null;
  restart_attempt_count: number;
  delegated_at: string;
  closed_at: string | null;
}

export interface SpecialistConversationSession {
  task_id: string;
  session_id: string;
  status: SpecialistConversationSessionStatus;
}

export type RawMemorySubmissionStatus = 'staged' | 'accepted';

export interface RawMemorySubmission {
  id: string;
  task_id: string;
  topic: string;
  staging_path: string;
  submitted_at: string;
  accepted_at: string | null;
  final_path: string | null;
  status: RawMemorySubmissionStatus;
  overdue_alerted_at: string | null;
}

// --- Container IPC transfer types ---

export type ContainerTransferStatus =
  | 'pending'
  | 'in_transit'
  | 'user_delivered'
  | 'expired';

export type TransferFileStatus = 'owned' | 'placed' | 'expired';

export interface ContainerTransfer {
  id: string;
  sender_invocation_id: string;
  sender_group_folder: string;
  message: string;
  file_count: number;
  sent_at: string;
  status: ContainerTransferStatus;
  recipient_task_id: string | null;
  recipient_group_folder: string | null;
}

export interface TransferFile {
  id: string;
  transfer_id: string;
  original_name: string;
  host_path: string;
  status: TransferFileStatus;
}

// --- WebXDC ---

export interface WebxdcUpdatePayload {
  content: string;
  title?: string;
  /** 'message' (default) or 'interactive' */
  type?: 'message' | 'interactive';
  /** Named surface: updates the card in-place instead of appending a new one */
  surfaceId?: string;
  /** Interactive component definitions (buttons, inputs, selects) */
  components?: unknown[];
  /** Short label used as the email-fallback update description */
  description?: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, sender?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: set an arbitrary reaction emoji on the last incoming message.
  setReaction?(jid: string, emoji: string): Promise<void>;
  // Optional: send a file/attachment to a chat.
  sendFile?(jid: string, filePath: string, caption?: string): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: send a message and return an opaque message ID (for later editing).
  sendMessageAndGetId?(jid: string, text: string): Promise<string | null>;
  // Optional: edit a previously sent message by its ID.
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
  // Optional: send the WebXDC chat surface app to a chat (DeltaChat only).
  sendWebxdcApp?(jid: string): Promise<void>;
  // Optional: send the Todo WebXDC app to a chat (DeltaChat only).
  sendTodoWebxdcApp?(jid: string): Promise<void>;
  // Optional: push a content update to a running WebXDC app session.
  // sessionName: targets a named session (e.g. 'todo') instead of the default nanoclaw.xdc session.
  sendWebxdcUpdate?(
    jid: string,
    payload: WebxdcUpdatePayload,
    sessionName?: string,
  ): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
