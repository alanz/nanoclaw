import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { XMLParser } from 'fast-xml-parser';
import { CronExpressionParser } from 'cron-parser';

import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  runContainerAgent,
  writeRssFeedsSnapshot,
} from './container-runner.js';
import {
  getAllRssFeeds,
  getDueRssFeeds,
  updateRssFeedAfterCheck,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup, RssFeed } from './types.js';

const MAX_SEEN_GUIDS = 500;
const MAX_ITEMS_IN_PROMPT = 20;
const MAX_DESCRIPTION_LENGTH = 300;

export interface RssItem {
  guid: string;
  title: string;
  link: string;
  description: string;
}

/**
 * Parse an RSS 2.0 or Atom feed XML string into a title and list of items.
 * Exported for testing.
 */
export function parseRssFeed(xml: string): { title: string; items: RssItem[] } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Some feeds use CDATA for descriptions; this handles them transparently
    cdataPropName: '#cdata',
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { title: '', items: [] };
  }

  // RSS 2.0
  const rss = parsed.rss as Record<string, unknown> | undefined;
  if (rss) {
    const channel = rss.channel as Record<string, unknown> | undefined;
    if (channel) {
      const rawItems = channel.item;
      const itemArray = Array.isArray(rawItems)
        ? rawItems
        : rawItems != null
          ? [rawItems]
          : [];

      const items: RssItem[] = itemArray
        .map((item: Record<string, unknown>) => {
          const guid = extractText(item.guid) || extractText(item.link) || '';
          const link = extractText(item.link) || '';
          const title = extractText(item.title) || '';
          const description =
            extractText(item.description) ||
            extractText(item.summary) ||
            extractText((item as Record<string, unknown>)['content:encoded']) ||
            '';
          return { guid, title, link, description };
        })
        .filter((i: RssItem) => i.guid || i.link);

      return { title: extractText(channel.title) || '', items };
    }
  }

  // Atom
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (feed) {
    const rawEntries = feed.entry;
    const entryArray = Array.isArray(rawEntries)
      ? rawEntries
      : rawEntries != null
        ? [rawEntries]
        : [];

    const items: RssItem[] = entryArray
      .map((entry: Record<string, unknown>) => {
        const link = extractAtomLink(entry.link);
        const guid = extractText(entry.id) || link || '';
        const title = extractText(entry.title) || '';
        const description =
          extractText(entry.summary) || extractText(entry.content) || '';
        return { guid, title, link, description };
      })
      .filter((i: RssItem) => i.guid || i.link);

    return { title: extractText(feed.title) || '', items };
  }

  return { title: '', items: [] };
}

function extractText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // CDATA content
    if (obj['#cdata'] != null) return String(obj['#cdata']);
    // Text node
    if (obj['#text'] != null) return String(obj['#text']);
  }
  return '';
}

function extractAtomLink(link: unknown): string {
  if (link == null) return '';
  if (typeof link === 'string') return link;
  if (Array.isArray(link)) {
    // Prefer rel="alternate" or first entry
    const alt = link.find(
      (l: unknown) =>
        typeof l === 'object' &&
        l !== null &&
        (l as Record<string, unknown>)['@_rel'] === 'alternate',
    ) as Record<string, unknown> | undefined;
    const chosen = (alt || link[0]) as Record<string, unknown> | undefined;
    return chosen ? String(chosen['@_href'] || '') : '';
  }
  if (typeof link === 'object') {
    return String((link as Record<string, unknown>)['@_href'] || '');
  }
  return '';
}

/**
 * Compute the next check time for a feed.
 * Exported for testing.
 */
export function computeNextCheck(feed: RssFeed, from?: Date): string {
  const now = (from ?? new Date()).getTime();

  if (feed.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(feed.schedule_value, {
      tz: TIMEZONE,
    });
    return (
      interval.next().toISOString() ??
      new Date(Date.now() + 86400000).toISOString()
    );
  }

  // interval
  const ms = parseInt(feed.schedule_value, 10);
  let next = new Date(feed.next_check!).getTime() + ms;
  while (next <= now) {
    next += ms;
  }
  return new Date(next).toISOString();
}

/**
 * Build the judgment prompt sent to the container agent.
 * Exported for testing.
 */
export function buildJudgmentPrompt(
  feed: RssFeed,
  newItems: RssItem[],
): string {
  const feedTitle = feed.title || feed.url;
  const capped = newItems.slice(0, MAX_ITEMS_IN_PROMPT);

  const itemList = capped
    .map((item, i) => {
      const desc = item.description.replace(/<[^>]*>/g, '').trim();
      const snippet =
        desc.length > MAX_DESCRIPTION_LENGTH
          ? desc.slice(0, MAX_DESCRIPTION_LENGTH) + '...'
          : desc;
      return (
        `${i + 1}. **${item.title || '(no title)'}**\n` +
        (item.link ? `   ${item.link}\n` : '') +
        (snippet ? `   ${snippet}` : '')
      );
    })
    .join('\n\n');

  const interestClause = feed.interest
    ? `The user is interested in: ${feed.interest}\n\nReview the items above and notify the user of anything that matches their interests. Be concise — mention the item title, link, and a brief note on why it's relevant. If nothing matches, respond with nothing (empty reply).`
    : `Summarize these new RSS items briefly for the user.`;

  return (
    `RSS feed update for "${feedTitle}" (${feed.url}):\n\n` +
    itemList +
    `\n\n---\n${interestClause}`
  );
}

export interface RssMonitorDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function checkFeed(feed: RssFeed, deps: RssMonitorDeps): Promise<void> {
  const startTime = Date.now();
  logger.info({ feedId: feed.id, url: feed.url }, 'Checking RSS feed');

  // Fetch the feed
  let xml: string;
  try {
    const response = await fetch(feed.url, {
      headers: { 'User-Agent': 'NanoClaw RSS Monitor/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    xml = await response.text();
  } catch (err) {
    logger.warn(
      { feedId: feed.id, url: feed.url, err },
      'RSS fetch failed, will retry at next check',
    );
    // Advance next_check by 15 minutes on error to avoid hammering bad URLs
    const retryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    updateRssFeedAfterCheck(feed.id, feed.seen_guids, retryAt);
    return;
  }

  // Parse
  const { title, items } = parseRssFeed(xml);

  // Diff against seen GUIDs
  let seenGuids: string[];
  try {
    seenGuids = JSON.parse(feed.seen_guids) as string[];
  } catch {
    seenGuids = [];
  }
  const seenSet = new Set(seenGuids);
  const newItems = items.filter((item) => item.guid && !seenSet.has(item.guid));

  // Merge seen GUIDs and cap at MAX_SEEN_GUIDS
  const allGuids = [
    ...seenGuids,
    ...newItems.map((i) => i.guid).filter(Boolean),
  ];
  const updatedSeenGuids = allGuids.slice(-MAX_SEEN_GUIDS);

  // Compute next check time
  const nextCheck = computeNextCheck(feed);

  // Persist updated state immediately (before spawning container)
  updateRssFeedAfterCheck(
    feed.id,
    JSON.stringify(updatedSeenGuids),
    nextCheck,
    title || undefined,
  );

  if (newItems.length === 0) {
    logger.info({ feedId: feed.id, url: feed.url }, 'No new RSS items');
    return;
  }

  logger.info(
    { feedId: feed.id, url: feed.url, newCount: newItems.length },
    'New RSS items found, spawning judgment container',
  );

  // Find the group
  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === feed.group_folder,
  );
  if (!group) {
    logger.warn(
      { feedId: feed.id, groupFolder: feed.group_folder },
      'RSS feed group not registered, skipping',
    );
    return;
  }

  const prompt = buildJudgmentPrompt(
    { ...feed, title: title || feed.title },
    newItems,
  );
  const isMain = group.isMain === true;

  // Write snapshot so the container can see feeds via list_rss_feeds
  const allFeeds = getAllRssFeeds();
  writeRssFeedsSnapshot(feed.group_folder, isMain, allFeeds);

  const TASK_CLOSE_DELAY_MS = 10_000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    await runContainerAgent(
      group,
      {
        prompt,
        sessionId: undefined, // always isolated — no chat history needed
        groupFolder: feed.group_folder,
        chatJid: feed.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: undefined,
      },
      (proc, containerName) =>
        deps.onProcess(feed.chat_jid, proc, containerName, feed.group_folder),
      async (streamedOutput) => {
        if (streamedOutput.result) {
          await deps.sendMessage(feed.chat_jid, streamedOutput.result);
          const digestPath = path.join(
            resolveGroupFolderPath(feed.group_folder),
            'rss-digest.md',
          );
          const entry =
            `\n\n## ${new Date().toISOString()} — ${feed.title || feed.url}\n\n` +
            streamedOutput.result;
          fs.appendFileSync(digestPath, entry);
          if (!closeTimer) {
            closeTimer = setTimeout(() => {
              deps.queue.closeStdin(feed.chat_jid);
            }, TASK_CLOSE_DELAY_MS);
          }
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(feed.chat_jid);
          if (!closeTimer) {
            closeTimer = setTimeout(() => {
              deps.queue.closeStdin(feed.chat_jid);
            }, TASK_CLOSE_DELAY_MS);
          }
        }
      },
    );
  } catch (err) {
    logger.error({ feedId: feed.id, err }, 'RSS judgment container failed');
  } finally {
    if (closeTimer) clearTimeout(closeTimer);
  }

  logger.info(
    { feedId: feed.id, durationMs: Date.now() - startTime },
    'RSS feed check complete',
  );
}

let rssMonitorRunning = false;

export function startRssMonitorLoop(deps: RssMonitorDeps): void {
  if (rssMonitorRunning) {
    logger.debug('RSS monitor loop already running, skipping duplicate start');
    return;
  }
  rssMonitorRunning = true;
  logger.info('RSS monitor loop started');

  const loop = async () => {
    try {
      const dueFeeds = getDueRssFeeds();
      if (dueFeeds.length > 0) {
        logger.info({ count: dueFeeds.length }, 'Found due RSS feeds');
      }

      for (const feed of dueFeeds) {
        deps.queue.enqueueTask(feed.chat_jid, `rss-${feed.id}`, () =>
          checkFeed(feed, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in RSS monitor loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetRssMonitorLoopForTests(): void {
  rssMonitorRunning = false;
}
