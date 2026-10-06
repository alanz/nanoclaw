import { readEnvFile } from '../../env.js';

const SETTINGS = ['SESSION_RESET_GROUPS', 'SESSION_RESET_TIME', 'SESSION_RESET_MIN_IDLE_MINUTES'] as const;

export interface SessionResetConfig {
  /** Agent group folders whose chat sessions are reset. Empty → module off. */
  groups: Set<string>;
  /** "HH:mm", local time in the group's timezone. */
  resetTime: string;
  minIdleMs: number;
  maxSummaryAttempts: number;
  sessionsIndexEntries: number;
}

function setting(key: (typeof SETTINGS)[number]): string | undefined {
  return process.env[key] ?? readEnvFile([...SETTINGS])[key];
}

export function loadSessionResetConfig(): SessionResetConfig {
  const time = setting('SESSION_RESET_TIME')?.trim() || '04:00';
  const idle = Number(setting('SESSION_RESET_MIN_IDLE_MINUTES') ?? 60);
  return {
    groups: new Set(
      (setting('SESSION_RESET_GROUPS') ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
    ),
    resetTime: /^\d{2}:\d{2}$/.test(time) ? time : '04:00',
    minIdleMs: (Number.isFinite(idle) && idle >= 0 ? idle : 60) * 60_000,
    maxSummaryAttempts: 3,
    sessionsIndexEntries: 7,
  };
}
