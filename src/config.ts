import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'GROUPS_DIR',
  'STORE_DIR',
  'WEB_UI_BASE_URL',
  'ZOTERO_GROUP_FOLDER',
  'ZOTERO_CHAT_JID',
  'ZOTERO_OUTPUT_DIR',
  'MEMORY_SEARCH_ENABLED',
  'MEMORY_SEARCH_GEMINI_API_KEY',
  'MEMORY_SEARCH_MODEL',
  'MEMORY_SEARCH_OUTPUT_DIMS',
  'MEMORY_SEARCH_EXTRA_PATHS',
  'MEMORY_SEARCH_MAX_RESULTS',
  'MEMORY_SEARCH_MIN_SCORE',
  'MEMORY_SEARCH_RPM_LIMIT',
  'MEMORY_SEARCH_RPD_SESSION_BUDGET',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const ZOTERO_POLL_INTERVAL = 3_600_000; // 1 hour

// Zotero integration — opt-in by setting these in .env
export const ZOTERO_GROUP_FOLDER: string | null =
  process.env.ZOTERO_GROUP_FOLDER || envConfig.ZOTERO_GROUP_FOLDER || null;
export const ZOTERO_CHAT_JID: string | null =
  process.env.ZOTERO_CHAT_JID || envConfig.ZOTERO_CHAT_JID || null;
// Container path for markdown output (default: inside group folder)
export const ZOTERO_OUTPUT_DIR: string =
  process.env.ZOTERO_OUTPUT_DIR ||
  envConfig.ZOTERO_OUTPUT_DIR ||
  '/workspace/group/zotero-md';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
export const HOME_DIR = process.env.HOME || os.homedir();

/** Expand a leading ~ and resolve to an absolute path, falling back to defaultPath. */
function resolveConfigDir(
  raw: string | undefined,
  defaultPath: string,
): string {
  const expanded = (raw || '').replace(/^~/, HOME_DIR);
  return path.resolve(expanded || defaultPath);
}

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = resolveConfigDir(
  process.env.STORE_DIR || envConfig.STORE_DIR,
  path.join(PROJECT_ROOT, 'store'),
);
export const GROUPS_DIR = resolveConfigDir(
  process.env.GROUPS_DIR || envConfig.GROUPS_DIR,
  path.join(PROJECT_ROOT, 'groups'),
);
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const WEB_UI_PORT = parseInt(process.env.WEB_UI_PORT || '3002', 10);
// Public-facing base URL for the web UI (e.g. a Tailscale Serve URL).
// Used so agents can generate shareable deep links into the dashboard.
export const WEB_UI_BASE_URL: string | null =
  (process.env.WEB_UI_BASE_URL || envConfig.WEB_UI_BASE_URL || '').replace(
    /\/$/,
    '',
  ) || null;
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '300000', 10); // 5min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- Memory search ---
export const MEMORY_SEARCH_ENABLED =
  (process.env.MEMORY_SEARCH_ENABLED ||
    envConfig.MEMORY_SEARCH_ENABLED ||
    'false') === 'true';

// API key is read only via readEnvFile (never from process.env) to avoid leaking into containers.
// Callers in src/memory/ should import MEMORY_SEARCH_GEMINI_API_KEY from here.
export const MEMORY_SEARCH_GEMINI_API_KEY: string | null =
  envConfig.MEMORY_SEARCH_GEMINI_API_KEY?.trim() || null;

export const MEMORY_SEARCH_MODEL: string =
  process.env.MEMORY_SEARCH_MODEL ||
  envConfig.MEMORY_SEARCH_MODEL ||
  'gemini-embedding-001';

export const MEMORY_SEARCH_OUTPUT_DIMS: number = parseInt(
  process.env.MEMORY_SEARCH_OUTPUT_DIMS ||
    envConfig.MEMORY_SEARCH_OUTPUT_DIMS ||
    '3072',
  10,
);

/** Comma-separated absolute paths to extra directories to index. */
export const MEMORY_SEARCH_EXTRA_PATHS: string[] = (
  process.env.MEMORY_SEARCH_EXTRA_PATHS ||
  envConfig.MEMORY_SEARCH_EXTRA_PATHS ||
  ''
)
  .split(',')
  .map((p) => p.trim().replace(/^~/, HOME_DIR))
  .filter(Boolean);

export const MEMORY_SEARCH_MAX_RESULTS: number = parseInt(
  process.env.MEMORY_SEARCH_MAX_RESULTS ||
    envConfig.MEMORY_SEARCH_MAX_RESULTS ||
    '6',
  10,
);

export const MEMORY_SEARCH_MIN_SCORE: number = parseFloat(
  process.env.MEMORY_SEARCH_MIN_SCORE ||
    envConfig.MEMORY_SEARCH_MIN_SCORE ||
    '0.35',
);

export const MEMORY_SEARCH_RPM_LIMIT: number = parseInt(
  process.env.MEMORY_SEARCH_RPM_LIMIT ||
    envConfig.MEMORY_SEARCH_RPM_LIMIT ||
    '70',
  10,
);

export const MEMORY_SEARCH_RPD_SESSION_BUDGET: number = parseInt(
  process.env.MEMORY_SEARCH_RPD_SESSION_BUDGET ||
    envConfig.MEMORY_SEARCH_RPD_SESSION_BUDGET ||
    '900',
  10,
);
