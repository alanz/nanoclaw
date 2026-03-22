/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_file',
  `Send a file or image to the user. The file must exist at a path under /workspace/ipc/ (e.g. /workspace/ipc/outgoing/result.jpg). For images you generate or download, write them there first, then call this tool.`,
  {
    file_path: z
      .string()
      .describe(
        'Absolute path to the file. Must be under /workspace/ipc/ (the only directory visible to both the container and the host).',
      ),
    caption: z.string().optional().describe('Optional caption text'),
  },
  async (args) => {
    const IPC_PREFIX = '/workspace/ipc/';
    if (!args.file_path.startsWith(IPC_PREFIX)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `file_path must be under ${IPC_PREFIX}. Got: ${args.file_path}`,
          },
        ],
        isError: true,
      };
    }
    const relativePath = args.file_path.slice(IPC_PREFIX.length);
    // Reject path traversal
    if (relativePath.includes('..')) {
      return {
        content: [
          { type: 'text' as const, text: 'file_path must not contain ..' },
        ],
        isError: true,
      };
    }
    const data: Record<string, string | undefined> = {
      type: 'file',
      chatJid,
      groupFolder,
      ipcRelativePath: relativePath,
      caption: args.caption,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: 'File queued for sending.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'set_group_trusted',
  `Grant or revoke trusted status for a registered group. Main group only.

A trusted group behaves like a 1:1 DM: no trigger word is required and session commands (/compact, /esc) are allowed from any sender. Use this for private groups that only contain the bot and its owner.`,
  {
    jid: z.string().describe('The chat JID of the group to update'),
    trusted: z.boolean().describe('True to grant trusted status, false to revoke it'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can set group trust.' }],
        isError: true,
      };
    }

    const data = {
      type: 'set_group_trusted',
      jid: args.jid,
      trusted: args.trusted,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group ${args.jid} trusted status set to ${args.trusted}.` }],
    };
  },
);

server.tool(
  'start_remote_control',
  `Start a Claude Code remote session accessible from any device (mobile, laptop, etc.).
The host will reply in chat with a claude.ai URL that opens a shared browser-based Claude Code session on the host machine.
Main group only. If a session is already running, returns the existing URL.`,
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can start a remote control session.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, { type: 'remote_control', chatJid, timestamp: new Date().toISOString() });

    return {
      content: [{ type: 'text' as const, text: 'Remote control requested. The URL will be sent to this chat when ready (up to 30 seconds).' }],
    };
  },
);

server.tool(
  'stop_remote_control',
  'Stop the active Claude Code remote control session. Main group only.',
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can stop a remote control session.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, { type: 'remote_control_stop', chatJid, timestamp: new Date().toISOString() });

    return {
      content: [{ type: 'text' as const, text: 'Remote control stop requested.' }],
    };
  },
);

server.tool(
  'subscribe_rss',
  `Subscribe to an RSS or Atom feed. The host will fetch the feed on the given schedule, compare new items to the user's interests, and notify if anything matches.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• interval: Milliseconds between checks (e.g., "86400000" for once per day, "3600000" for hourly)
• cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am)

INTEREST: Describe what the user cares about. Be specific. This is injected into the judgment prompt on every check. Example: "Rust, WebAssembly, distributed systems, database internals".
If no interest is provided, all new items are summarized and sent.`,
  {
    url: z.string().describe('RSS or Atom feed URL'),
    schedule_type: z.enum(['interval', 'cron']).default('interval'),
    schedule_value: z.string().default('86400000').describe('interval: ms (e.g. "86400000" = 1 day) | cron: expression (e.g. "0 9 * * *")'),
    interest: z.string().optional().describe('What the user is interested in — used to filter items by relevance'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to subscribe for. Defaults to current group.'),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am).` }],
          isError: true,
        };
      }
    } else {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds.` }],
          isError: true,
        };
      }
    }

    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const feedId = `rss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'subscribe_rss',
      feedId,
      feedUrl: args.url,
      feedScheduleType: args.schedule_type,
      feedScheduleValue: args.schedule_value,
      feedInterest: args.interest,
      targetJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `RSS feed subscribed (${feedId}): ${args.url} — checks every ${args.schedule_type === 'cron' ? args.schedule_value : Math.round(parseInt(args.schedule_value) / 3600000) + 'h'}.` }],
    };
  },
);

server.tool(
  'unsubscribe_rss',
  'Remove an RSS feed subscription.',
  {
    feed_id: z.string().describe('The feed ID to unsubscribe (from list_rss_feeds)'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'unsubscribe_rss',
      feedId: args.feed_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `RSS feed ${args.feed_id} unsubscribed.` }] };
  },
);

server.tool(
  'list_rss_feeds',
  "List active RSS feed subscriptions. From main: shows all feeds. From other groups: shows only that group's feeds.",
  {},
  async () => {
    const feedsFile = path.join(IPC_DIR, 'rss_feeds.json');
    try {
      if (!fs.existsSync(feedsFile)) {
        return { content: [{ type: 'text' as const, text: 'No RSS feed subscriptions found.' }] };
      }
      const feeds = JSON.parse(fs.readFileSync(feedsFile, 'utf-8')) as Array<{
        id: string; url: string; title: string | null; schedule_type: string;
        schedule_value: string; next_check: string | null; interest: string | null; group_folder: string;
      }>;
      if (!feeds.length) {
        return { content: [{ type: 'text' as const, text: 'No RSS feed subscriptions found.' }] };
      }
      const formatted = feeds
        .map((f) =>
          `- [${f.id}] ${f.title || f.url} (${f.schedule_type}: ${f.schedule_value})` +
          (f.interest ? ` — interests: ${f.interest}` : '') +
          (f.next_check ? ` — next: ${f.next_check}` : ''),
        )
        .join('\n');
      return { content: [{ type: 'text' as const, text: `RSS feeds:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading feeds: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'query_transcript',
  `Query the message history for this group. Returns messages with their timestamp, sender, direction (inbound = from user, outbound = sent by bot), and content.

TIME WINDOW: Use ISO 8601 timestamps for from/to (e.g. "2026-03-19T00:00:00.000Z"). Both are optional.

PAGINATION: The response includes has_more (boolean) and next_cursor. If has_more is true, pass next_cursor as after_cursor in the next call to retrieve the following page.`,
  {
    from: z
      .string()
      .optional()
      .describe(
        'Start of time window (ISO 8601, inclusive). Omit to start from the beginning of history.',
      ),
    to: z
      .string()
      .optional()
      .describe(
        'End of time window (ISO 8601, inclusive). Omit to include messages up to now.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Maximum messages to return (1–200, default 50).'),
    after_cursor: z
      .string()
      .optional()
      .describe(
        'Pagination cursor from a previous response (the next_cursor field). Returns the next page.',
      ),
  },
  async (args) => {
    const requestId = `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'query_transcript',
      requestId,
      chatJid,
      from: args.from,
      to: args.to,
      limit: args.limit ?? 50,
      afterCursor: args.after_cursor,
      timestamp: new Date().toISOString(),
    });

    const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
    const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (fs.existsSync(responseFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error reading transcript response: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Transcript query timed out. The host may be busy — try again.',
        },
      ],
      isError: true,
    };
  },
);

server.tool(
  'memory_search',
  `Search your personal knowledge base (org notes, workspace memory files, research documents). Use when the user references something you may have notes on, or when background context would improve your answer. Also use when creating a new A-MEM note to find related notes for the links field.

Returns ranked results with path, line range, score, and snippet. Use memory_get to fetch the full content of a result.

Params:
- query: What to search for (required)
- limit: Max results, default 6, max 20
- path_prefix: Filter to a subtree, e.g. "memory/notes/" or "memory/reports/"
- source: Filter by source — "memory" (workspace files), "org" (org-mode), "zotero"
- min_score: Min relevance 0–1, default 0.35
- include_content: Also return full file text + parsed frontmatter (enforces limit ≤ 10)`,
  {
    query: z.string().describe('What to search for'),
    limit: z.number().optional().describe('Max results (default 6, max 20)'),
    path_prefix: z.string().optional().describe('Filter to path subtree, e.g. "memory/notes/"'),
    source: z.string().optional().describe('Filter by source: "memory", "org", or "zotero"'),
    min_score: z.number().optional().describe('Min relevance score 0–1 (default 0.35)'),
    include_content: z.boolean().optional().describe('Also return full file text and frontmatter'),
  },
  async (args) => {
    const requestId = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'memory_search',
      requestId,
      groupFolder,
      query: args.query,
      limit: args.limit,
      path_prefix: args.path_prefix,
      source: args.source,
      min_score: args.min_score,
      include_content: args.include_content,
      timestamp: new Date().toISOString(),
    });

    const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
    const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (fs.existsSync(responseFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading memory_search response: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'memory_search timed out. The host may be busy — try again.' }],
      isError: true,
    };
  },
);

server.tool(
  'memory_get',
  `Read the full content of a specific file from your knowledge base. Use the path from memory_search results. For A-MEM note-taking: use to read existing notes' links field before updating them.

Returns the full file text, size, indexed status, and optionally parsed YAML frontmatter (id, keywords, tags, links fields).`,
  {
    path: z.string().describe('Relative file path (from memory_search result, or relative to /workspace/group/)'),
    parse_frontmatter: z.boolean().optional().describe('Parse YAML front matter (default true)'),
  },
  async (args) => {
    const requestId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'memory_get',
      requestId,
      groupFolder,
      path: args.path,
      parse_frontmatter: args.parse_frontmatter,
      timestamp: new Date().toISOString(),
    });

    const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
    const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (fs.existsSync(responseFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading memory_get response: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'memory_get timed out. The host may be busy — try again.' }],
      isError: true,
    };
  },
);

server.tool(
  'memory_list',
  `List indexed files in your knowledge base matching a path prefix. Use for A-MEM consolidation: find recent notes without links, audit the memory/notes/ directory. No semantic query — just file metadata.

Returns file paths, modification times, sizes, and optionally parsed frontmatter.`,
  {
    path_prefix: z.string().optional().describe('Filter to path subtree, e.g. "memory/notes/"'),
    source: z.string().optional().describe('Filter by source: "memory", "org", or "zotero"'),
    limit: z.number().optional().describe('Max files to return (default 50, max 200; max 50 when parse_frontmatter=true)'),
    order_by: z.enum(['mtime', 'path', 'size']).optional().describe('Sort order (default mtime descending)'),
    parse_frontmatter: z.boolean().optional().describe('Parse YAML frontmatter for each file (expensive — enforces limit ≤ 50)'),
  },
  async (args) => {
    const requestId = `ml-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'memory_list',
      requestId,
      groupFolder,
      path_prefix: args.path_prefix,
      source: args.source,
      limit: args.limit,
      order_by: args.order_by,
      parse_frontmatter: args.parse_frontmatter,
      timestamp: new Date().toISOString(),
    });

    const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
    const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (fs.existsSync(responseFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading memory_list response: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'memory_list timed out. The host may be busy — try again.' }],
      isError: true,
    };
  },
);

/**
 * Pure function for building a dashboard URL — exported for testing.
 * Returns null if webUiBaseUrl is not set.
 */
export function buildDashboardUrl(
  webUiBaseUrl: string | null,
  groupFolder: string,
  filePath?: string,
  view: 'chat' | 'tasks' | 'files' = 'files',
): string | null {
  if (!webUiBaseUrl) return null;
  let hash: string;
  if (filePath) {
    let rel = filePath;
    if (rel.startsWith('/workspace/')) rel = rel.slice('/workspace/'.length);
    else if (rel.startsWith('workspace/')) rel = rel.slice('workspace/'.length);
    rel = rel.replace(/^\/+/, '');
    // /workspace/group/ maps to the group folder on the host — strip it
    if (rel.startsWith('group/')) rel = rel.slice('group/'.length);
    hash = `groups/${groupFolder}/files/${rel}`;
  } else {
    hash =
      view === 'chat'
        ? `groups/${groupFolder}`
        : `groups/${groupFolder}/${view}`;
  }
  return `${webUiBaseUrl}#${hash}`;
}

/**
 * Pure function — inverse of buildDashboardUrl.
 * Parses a dashboard URL back to its components.
 * Returns null if the URL is not a recognisable dashboard URL.
 */
export function parseDashboardUrl(url: string): {
  groupFolder: string;
  filePath: string | null;
  view: 'chat' | 'tasks' | 'files';
} | null {
  let hash: string;
  try {
    const parsed = new URL(url);
    hash = parsed.hash.replace(/^#/, '');
  } catch {
    return null;
  }
  // hash forms:
  //   groups/{folder}/files/{rel}  → file
  //   groups/{folder}/files        → files tab
  //   groups/{folder}/tasks        → tasks tab
  //   groups/{folder}              → chat tab
  const fileMatch = hash.match(/^groups\/([^/]+)\/files\/(.+)$/);
  if (fileMatch) {
    return { groupFolder: fileMatch[1], filePath: `/workspace/${fileMatch[2]}`, view: 'files' };
  }
  const tabMatch = hash.match(/^groups\/([^/]+)\/(files|tasks)$/);
  if (tabMatch) {
    return { groupFolder: tabMatch[1], filePath: null, view: tabMatch[2] as 'files' | 'tasks' };
  }
  const chatMatch = hash.match(/^groups\/([^/]+)$/);
  if (chatMatch) {
    return { groupFolder: chatMatch[1], filePath: null, view: 'chat' };
  }
  return null;
}

server.tool(
  'get_file_path',
  `Convert a NanoClaw dashboard URL back to its workspace file path.

Use this when you have a dashboard URL (e.g. shared by the user or found in an index) and need to read or write the underlying file.

Returns the absolute workspace path (e.g. "/workspace/notes/todo.md") for file URLs, or a description of the view (chat/tasks/files tab) for group-level URLs.`,
  {
    url: z.string().describe('A NanoClaw dashboard URL (the value returned by get_file_url).'),
  },
  async (args) => {
    const result = parseDashboardUrl(args.url);
    if (!result) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Not a recognisable NanoClaw dashboard URL: ${args.url}`,
          },
        ],
      };
    }
    if (result.filePath) {
      return { content: [{ type: 'text' as const, text: result.filePath }] };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Group: ${result.groupFolder}, view: ${result.view} (no specific file)`,
        },
      ],
    };
  },
);

server.tool(
  'get_file_url',
  `Get a shareable dashboard URL for a file in your workspace, or for a group view (chat, tasks, files tab).

The URL points to the NanoClaw web dashboard and can be shared directly with the user.

FILE URL: Pass a workspace file path (e.g. "/workspace/CLAUDE.md" or "notes/todo.md"). The dashboard will open that file in the Files tab.
GROUP VIEWS: Omit file_path and set view to "chat", "tasks", or "files" for the respective tab.`,
  {
    file_path: z
      .string()
      .optional()
      .describe(
        'Path to the workspace file. Can be absolute (/workspace/...) or relative to /workspace/. Omit for group-level views.',
      ),
    view: z
      .enum(['chat', 'tasks', 'files'])
      .optional()
      .default('files')
      .describe('Which tab to open when no file_path is given (default: files).'),
  },
  async (args) => {
    const metaFile = path.join(IPC_DIR, 'nanoclaw_meta.json');
    let webUiBaseUrl: string | null = null;
    try {
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        webUiBaseUrl = meta.webUiBaseUrl ?? null;
      }
    } catch {
      // file unreadable — leave webUiBaseUrl null
    }

    const url = buildDashboardUrl(webUiBaseUrl, groupFolder, args.file_path, args.view ?? 'files');
    if (!url) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Web UI base URL is not configured. The dashboard URL cannot be generated.',
          },
        ],
      };
    }
    return { content: [{ type: 'text' as const, text: url }] };
  },
);

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

if (BRAVE_API_KEY) {
  server.tool(
    'brave_web_search',
    'Search the web using Brave Search API. Use for current events, factual lookups, news, and general web research.',
    {
      query: z.string().describe('Search query (max 400 chars)'),
      count: z.number().int().min(1).max(20).default(10).describe('Number of results (1-20, default 10)'),
      country: z.string().optional().describe('Country code to localise results (e.g. "us", "gb")'),
      freshness: z.string().optional().describe('Filter by age: "pd" past day, "pw" past week, "pm" past month, "py" past year, or date range "YYYY-MM-DDtoYYYY-MM-DD"'),
    },
    async (args) => {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', args.query);
      url.searchParams.set('count', String(args.count ?? 10));
      if (args.country) url.searchParams.set('country', args.country);
      if (args.freshness) url.searchParams.set('freshness', args.freshness);

      try {
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': BRAVE_API_KEY,
          },
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return {
            content: [{ type: 'text' as const, text: `Brave Search error (${res.status}): ${detail || res.statusText}` }],
            isError: true,
          };
        }

        const data = await res.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } };
        const results = data.web?.results ?? [];
        const formatted = results
          .map((r, i) =>
            `${i + 1}. **${r.title ?? ''}**\n   ${r.url ?? ''}\n   ${r.description ?? ''}${r.age ? ` (${r.age})` : ''}`,
          )
          .join('\n\n');

        return {
          content: [{ type: 'text' as const, text: formatted || 'No results found.' }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

// ── search_zotero ─────────────────────────────────────────────────────────────

const ZOTERO_MD_DIR = '/workspace/group/zotero-md';

if (fs.existsSync(ZOTERO_MD_DIR)) {
  interface ZoteroEntry {
    file: string;
    meta: Record<string, string>;
    body: string;
    score: number;
  }

  function parseZoteroFrontMatter(text: string): { meta: Record<string, string>; body: string } | null {
    if (!text.startsWith('---')) return null;
    const nl = text.indexOf('\n');
    if (nl < 0) return null;
    const end = text.indexOf('\n---', nl + 1);
    if (end < 0) return null;
    const fmText = text.slice(nl + 1, end);
    const bodyStart = end + 4 + (text[end + 4] === '\n' ? 1 : 0);
    const meta: Record<string, string> = {};
    for (const line of fmText.split('\n')) {
      const colon = line.indexOf(': ');
      if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 2).trim();
    }
    return { meta, body: text.slice(bodyStart) };
  }

  function scoreEntry(terms: string[], meta: Record<string, string>, body: string): number {
    const title   = (meta.title   || '').toLowerCase();
    const authors = (meta.authors || '').toLowerCase();
    const tags    = (meta.tags    || '').toLowerCase();
    const bodyLow = body.toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (title.includes(term))   score += 3;
      if (authors.includes(term)) score += 2;
      if (tags.includes(term))    score += 2;
      if (bodyLow.includes(term)) score += 1;
    }
    return score;
  }

  server.tool(
    'search_zotero',
    `Search your Zotero library of papers. Returns matching papers with metadata and abstract snippets.

Searches across: title, authors, abstract, and tags. All query terms must match at least somewhere for a result to appear.

Useful for: finding papers on a topic, checking if a paper is in the library, exploring what's been read on a subject.`,
    {
      query: z.string().describe('Search terms (e.g. "abstract interpretation staging")'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results (default 10)'),
      year_from: z.number().int().optional().describe('Only papers published from this year'),
      year_to: z.number().int().optional().describe('Only papers published up to this year'),
      tag: z.string().optional().describe('Only papers with this tag'),
      has_abstract: z.boolean().optional().describe('true = only papers with an abstract, false = only without'),
    },
    async (args) => {
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);

      let files: string[];
      try {
        files = fs.readdirSync(ZOTERO_MD_DIR).filter((f) => f.endsWith('.md'));
      } catch {
        return { content: [{ type: 'text' as const, text: 'Zotero library directory not found.' }] };
      }

      const results: ZoteroEntry[] = [];

      for (const file of files) {
        const text = fs.readFileSync(path.join(ZOTERO_MD_DIR, file), 'utf-8');
        const parsed = parseZoteroFrontMatter(text);
        if (!parsed) continue;
        const { meta, body } = parsed;

        // Year filters
        const year = meta.year ? parseInt(meta.year, 10) : null;
        if (args.year_from !== undefined && (year === null || year < args.year_from)) continue;
        if (args.year_to   !== undefined && (year === null || year > args.year_to))   continue;

        // Tag filter
        if (args.tag) {
          const tags = (meta.tags || '').toLowerCase();
          if (!tags.includes(args.tag.toLowerCase())) continue;
        }

        // Abstract filter
        const bodyLines = body.split('\n').filter((l) => l.trim());
        const abstractPresent = bodyLines.length > 2;
        if (args.has_abstract === true  && !abstractPresent) continue;
        if (args.has_abstract === false &&  abstractPresent) continue;

        const score = scoreEntry(terms, meta, body);
        if (score === 0) continue;  // must match at least one term somewhere

        results.push({ file, meta, body, score });
      }

      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, args.limit ?? 10);

      if (top.length === 0) {
        return { content: [{ type: 'text' as const, text: `No results for "${args.query}".` }] };
      }

      const formatted = top.map((r, i) => {
        const m = r.meta;
        const year = m.year ? ` (${m.year})` : '';
        const authors = m.authors ? `\n   Authors: ${m.authors}` : '';
        const doi = m.doi ? `\n   DOI: ${m.doi}` : '';
        const tags = m.tags ? `\n   Tags: ${m.tags}` : '';
        // Extract abstract snippet from body (skip title + authors lines)
        const bodyLines = r.body.split('\n').filter((l) => l.trim());
        const snippet = bodyLines.length > 2
          ? bodyLines.slice(2).join(' ').slice(0, 200).trim() + (bodyLines.slice(2).join(' ').length > 200 ? '…' : '')
          : '';
        const abstractLine = snippet ? `\n   Abstract: ${snippet}` : '';
        return `${i + 1}. **${m.title || r.file}**${year}${authors}${doi}${tags}${abstractLine}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `Found ${results.length} result${results.length === 1 ? '' : 's'} (showing ${top.length}):\n\n${formatted}` }],
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
