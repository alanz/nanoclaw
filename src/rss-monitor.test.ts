import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  parseRssFeed,
  buildJudgmentPrompt,
  checkFeed,
  computeNextCheck,
  diffNewItems,
  mergeAndCapGuids,
  parseSeenGuids,
  _resetRssMonitorLoopForTests,
} from './rss-monitor.js';
import { _initTestDatabase } from './db.js';
import { RssFeed } from './types.js';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeRssFeedsSnapshot: vi.fn(),
}));

function makeFeed(overrides: Partial<RssFeed> = {}): RssFeed {
  return {
    id: 'rss-test-1',
    group_folder: 'main',
    chat_jid: 'test@g.us',
    url: 'https://example.com/feed.xml',
    title: 'Test Feed',
    schedule_type: 'interval',
    schedule_value: '3600000',
    status: 'active',
    next_check: new Date(Date.now() - 1000).toISOString(),
    seen_guids: '[]',
    interest: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetRssMonitorLoopForTests();
});

// ── parseRssFeed ─────────────────────────────────────────────────────────────

describe('parseRssFeed', () => {
  it('parses a minimal RSS 2.0 feed', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>My Blog</title>
    <item>
      <title>Post 1</title>
      <link>https://blog.example.com/1</link>
      <guid>https://blog.example.com/1</guid>
      <description>First post</description>
    </item>
    <item>
      <title>Post 2</title>
      <link>https://blog.example.com/2</link>
      <guid>post-2</guid>
      <description>Second post</description>
    </item>
  </channel>
</rss>`;
    const { title, items } = parseRssFeed(xml);
    expect(title).toBe('My Blog');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Post 1');
    expect(items[0].guid).toBe('https://blog.example.com/1');
    expect(items[0].link).toBe('https://blog.example.com/1');
    expect(items[1].guid).toBe('post-2');
  });

  it('handles a single RSS item (not wrapped in array)', () => {
    const xml = `<rss version="2.0">
  <channel>
    <title>Single</title>
    <item>
      <title>Only Post</title>
      <link>https://example.com/only</link>
      <guid>only</guid>
    </item>
  </channel>
</rss>`;
    const { items } = parseRssFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Only Post');
  });

  it('uses link as guid fallback when guid is absent', () => {
    const xml = `<rss version="2.0"><channel><item>
      <title>No guid</title>
      <link>https://example.com/no-guid</link>
    </item></channel></rss>`;
    const { items } = parseRssFeed(xml);
    expect(items[0].guid).toBe('https://example.com/no-guid');
  });

  it('parses a minimal Atom feed', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Entry One</title>
    <link href="https://atom.example.com/1"/>
    <id>urn:uuid:entry-one</id>
    <summary>Summary text</summary>
  </entry>
  <entry>
    <title>Entry Two</title>
    <link href="https://atom.example.com/2"/>
    <id>urn:uuid:entry-two</id>
  </entry>
</feed>`;
    const { title, items } = parseRssFeed(xml);
    expect(title).toBe('Atom Feed');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Entry One');
    expect(items[0].guid).toBe('urn:uuid:entry-one');
    expect(items[0].link).toBe('https://atom.example.com/1');
    expect(items[0].description).toBe('Summary text');
  });

  it('handles single Atom entry (not wrapped in array)', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Single</title>
  <entry>
    <id>single-1</id>
    <title>Only Entry</title>
    <link href="https://example.com/single"/>
  </entry>
</feed>`;
    const { items } = parseRssFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].guid).toBe('single-1');
  });

  it('returns empty on invalid XML', () => {
    const { title, items } = parseRssFeed('not xml at all <<<');
    expect(title).toBe('');
    expect(items).toHaveLength(0);
  });

  it('returns empty on empty string', () => {
    const { title, items } = parseRssFeed('');
    expect(title).toBe('');
    expect(items).toHaveLength(0);
  });
});

// ── buildJudgmentPrompt ───────────────────────────────────────────────────────

describe('buildJudgmentPrompt', () => {
  const items = [
    {
      guid: 'g1',
      title: 'Rust 2.0 Released',
      link: 'https://rust-lang.org/news',
      description: 'Major release of Rust.',
    },
    {
      guid: 'g2',
      title: 'Python Updates',
      link: 'https://python.org/news',
      description: 'Python minor update.',
    },
  ];

  it('includes feed title and URL', () => {
    const feed = makeFeed({ title: 'HN', url: 'https://hnrss.org/frontpage' });
    const prompt = buildJudgmentPrompt(feed, items);
    expect(prompt).toContain('"HN"');
    expect(prompt).toContain('https://hnrss.org/frontpage');
  });

  it('includes item titles and links', () => {
    const feed = makeFeed();
    const prompt = buildJudgmentPrompt(feed, items);
    expect(prompt).toContain('Rust 2.0 Released');
    expect(prompt).toContain('https://rust-lang.org/news');
    expect(prompt).toContain('Python Updates');
  });

  it('includes interest clause when interest is set', () => {
    const feed = makeFeed({ interest: 'Rust, compilers' });
    const prompt = buildJudgmentPrompt(feed, items);
    expect(prompt).toContain('Rust, compilers');
    expect(prompt).toContain('notify the user');
    expect(prompt).toContain('empty reply');
  });

  it('uses summarise clause when no interest', () => {
    const feed = makeFeed({ interest: null });
    const prompt = buildJudgmentPrompt(feed, items);
    expect(prompt).toContain('Summarize');
  });

  it('truncates descriptions longer than 300 chars', () => {
    const longDesc = 'x'.repeat(400);
    const longItems = [
      {
        guid: 'g1',
        title: 'Long',
        link: 'https://example.com',
        description: longDesc,
      },
    ];
    const prompt = buildJudgmentPrompt(makeFeed(), longItems);
    expect(prompt).toContain('...');
    expect(prompt.length).toBeLessThan(longDesc.length + 500);
  });

  it('caps at 20 items', () => {
    const manyItems = Array.from({ length: 25 }, (_, i) => ({
      guid: `g${i}`,
      title: `Item ${i}`,
      link: `https://example.com/${i}`,
      description: '',
    }));
    const prompt = buildJudgmentPrompt(makeFeed(), manyItems);
    // Items 21-25 should not appear
    expect(prompt).not.toContain('Item 20');
    expect(prompt).not.toContain('Item 24');
    expect(prompt).toContain('Item 19');
  });
});

// ── computeNextCheck ─────────────────────────────────────────────────────────

describe('computeNextCheck', () => {
  it('adds interval ms to the current next_check', () => {
    const base = new Date('2026-01-01T12:00:00.000Z');
    const feed = makeFeed({
      schedule_type: 'interval',
      schedule_value: '3600000', // 1 hour
      next_check: base.toISOString(),
    });
    const next = computeNextCheck(feed, new Date(base.getTime() + 1000));
    expect(next).toBe(new Date(base.getTime() + 3600000).toISOString());
  });

  it('skips past missed intervals when significantly overdue', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    const feed = makeFeed({
      schedule_type: 'interval',
      schedule_value: '3600000',
      next_check: base.toISOString(),
    });
    // 5 hours have passed since next_check
    const now = new Date(base.getTime() + 5 * 3600000 + 1000);
    const next = computeNextCheck(feed, now);
    const nextDate = new Date(next);
    expect(nextDate.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns a future date for a valid cron expression', () => {
    const feed = makeFeed({
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      next_check: new Date().toISOString(),
    });
    const next = computeNextCheck(feed);
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('seen GUID helpers', () => {
  describe('parseSeenGuids', () => {
    it('parses a valid JSON array', () => {
      expect(parseSeenGuids('["a","b","c"]')).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for invalid JSON', () => {
      expect(parseSeenGuids('not-json')).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(parseSeenGuids('')).toEqual([]);
    });
  });

  describe('diffNewItems', () => {
    const items = [
      { guid: 'a', title: 'A', link: '', description: '' },
      { guid: 'b', title: 'B', link: '', description: '' },
      { guid: 'c', title: 'C', link: '', description: '' },
    ];

    it('returns only items not in seenGuids', () => {
      expect(diffNewItems(items, ['a', 'b'])).toEqual([items[2]]);
    });

    it('returns all items when seenGuids is empty', () => {
      expect(diffNewItems(items, [])).toEqual(items);
    });

    it('returns nothing when all items are seen', () => {
      expect(diffNewItems(items, ['a', 'b', 'c'])).toEqual([]);
    });

    it('excludes items with no guid', () => {
      const withNull = [{ guid: '', title: 'X', link: '', description: '' }];
      expect(diffNewItems(withNull, [])).toEqual([]);
    });
  });

  describe('mergeAndCapGuids', () => {
    it('merges existing and incoming', () => {
      expect(mergeAndCapGuids(['a', 'b'], ['c'])).toEqual(['a', 'b', 'c']);
    });

    it('caps at 500, trimming from the oldest end', () => {
      const existing = Array.from({ length: 498 }, (_, i) => `old-${i}`);
      const incoming = ['new-1', 'new-2', 'new-3'];
      const result = mergeAndCapGuids(existing, incoming);
      expect(result).toHaveLength(500);
      expect(result.at(-1)).toBe('new-3');
      expect(result.at(-2)).toBe('new-2');
      expect(result.at(-3)).toBe('new-1');
      expect(result[0]).toBe('old-1'); // old-0 was trimmed
    });

    it('does not trim when total is exactly 500', () => {
      const existing = Array.from({ length: 499 }, (_, i) => `g-${i}`);
      const result = mergeAndCapGuids(existing, ['final']);
      expect(result).toHaveLength(500);
      expect(result[0]).toBe('g-0');
    });
  });
});

// ── checkFeed sender ─────────────────────────────────────────────────────────

const MINIMAL_RSS_XML = `<rss version="2.0"><channel><title>Feed</title>
  <item><title>New Item</title><link>https://example.com/1</link><guid>g-new</guid></item>
</channel></rss>`;

function makeGroup(folder: string, _jid: string) {
  return {
    name: 'Test Group',
    folder,
    trigger: 'test',
    added_at: new Date().toISOString(),
    isMain: true,
  };
}

describe('checkFeed sender', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes feed title as sender when title is set', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _opts, _onProcess, onOutput) => {
        await onOutput!({ result: 'summary text', status: 'success' });
        return { result: 'summary text', status: 'success' } as any;
      },
    );
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      text: async () => MINIMAL_RSS_XML,
    }));

    const feed = makeFeed({ title: 'Tech News', seen_guids: '[]' });
    const sendMessage = vi.fn(async () => {});

    await checkFeed(feed, {
      registeredGroups: () => ({
        [feed.group_folder]: makeGroup(feed.group_folder, feed.chat_jid) as any,
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(),
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: vi.fn(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      feed.chat_jid,
      'summary text',
      'Tech News',
    );
  });

  it('falls back to RSS when feed title is null', async () => {
    const { runContainerAgent } = await import('./container-runner.js');
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _opts, _onProcess, onOutput) => {
        await onOutput!({ result: 'summary text', status: 'success' });
        return { result: 'summary text', status: 'success' } as any;
      },
    );
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      text: async () => MINIMAL_RSS_XML,
    }));

    const feed = makeFeed({ title: null, seen_guids: '[]' });
    const sendMessage = vi.fn(async () => {});

    await checkFeed(feed, {
      registeredGroups: () => ({
        [feed.group_folder]: makeGroup(feed.group_folder, feed.chat_jid) as any,
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(),
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: vi.fn(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      feed.chat_jid,
      'summary text',
      'RSS',
    );
  });
});
