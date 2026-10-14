/**
 * The WebXDC chat surface's RPC-free parts, against the real filesystem: the
 * .xdc archive, the instance book, update parsing — and a guard on the app
 * source itself, so it keeps the rules that make a WebXDC app work
 * (webxdc.js loaded and not bundled, nothing from the network, no raw HTML
 * from the model).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import zlib from 'zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_SOURCE_DIR,
  WebxdcBook,
  buildXdc,
  inlineImage,
  instanceOfThread,
  parseAppUpdate,
  statusUpdate,
  xdcThread,
} from './deltachat-webxdc.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webxdc-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Read a ZIP built by buildXdc back into name → contents, via its central directory. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf-8');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(dataAt, dataAt + size));
    expect(zlib.crc32(data)).toBe(buf.readUInt32LE(at + 16));
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

describe('buildXdc', () => {
  it('zips every top-level file, index.html at the root, contents intact', () => {
    fs.writeFileSync(path.join(tmp, 'index.html'), '<p>hi</p>');
    fs.writeFileSync(path.join(tmp, 'manifest.toml'), 'name = "X"\n');
    fs.writeFileSync(path.join(tmp, '.hidden'), 'skip me');
    fs.mkdirSync(path.join(tmp, 'sub'));
    const files = unzip(buildXdc(tmp));
    expect([...files.keys()]).toEqual(['index.html', 'manifest.toml']);
    expect(files.get('index.html')!.toString()).toBe('<p>hi</p>');
  });

  it('packages the real app', () => {
    const files = unzip(buildXdc(APP_SOURCE_DIR));
    expect([...files.keys()].sort()).toEqual(['icon.png', 'index.html', 'manifest.toml', 'marked.min.js']);
  });
});

describe('the app source', () => {
  const html = fs.readFileSync(path.join(APP_SOURCE_DIR, 'index.html'), 'utf-8');

  it('loads webxdc.js before its own scripts and does not bundle it', () => {
    const scripts = [...html.matchAll(/<script(?: src="([^"]+)")?>/g)].map((m) => m[1] ?? 'inline');
    expect(scripts[0]).toBe('webxdc.js');
    expect(fs.existsSync(path.join(APP_SOURCE_DIR, 'webxdc.js'))).toBe(false);
  });

  it('loads nothing from the network', () => {
    expect(html).not.toMatch(/<(script|img|link|iframe)\b[^>]*\b(src|href)=["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import|url\(\s*["']?(https?:)?\/\//i);
  });

  it('never turns model HTML into markup, and only allows safe links and inline images', () => {
    expect(html).toMatch(/html\(token\)\s*\{\s*return escapeHtml/);
    expect(html).toMatch(/\^\(https\?:\|mailto:\)/);
    expect(html).toMatch(/\^data:image\\\/\(png\|jpeg\|gif\|webp\);base64,/);
  });

  it("renders the model's Markdown safely (the app's own renderer, run on its vendored marked)", () => {
    const ctx: Record<string, unknown> = {};
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(APP_SOURCE_DIR, 'marked.min.js'), 'utf-8'), ctx);
    const start = html.indexOf('function escapeHtml');
    const end = html.indexOf('\n', html.indexOf('function renderMarkdown'));
    vm.runInContext(html.slice(start, end), ctx);
    const render = (md: string) => (vm.runInContext(`renderMarkdown(${JSON.stringify(md)})`, ctx) as string).trim();

    expect(render('<script>alert(1)</script>hi')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;hi');
    expect(render('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(render('[click](javascript:alert(1))')).toBe('<p>click</p>');
    expect(render('[ok](https://example.com)')).toContain(
      '<a href="https://example.com" rel="noopener noreferrer">ok</a>',
    );
    expect(render('![x](https://evil.example/p.png)')).toBe('<p>[image: x]</p>');
    expect(render('![c](data:image/png;base64,iVBORw0KGgo=)')).toContain(
      '<img src="data:image/png;base64,iVBORw0KGgo="',
    );
    expect(render('**bold** and `code`')).toBe('<p><strong>bold</strong> and <code>code</code></p>');
  });

  it('keeps the startup handling learned on real devices', () => {
    expect(html).toMatch(/restoreCache/);
    expect(html).toMatch(/typeof window\.webxdc === 'undefined'/);
    expect(html).toMatch(/joinRealtimeChannel/);
    expect(html).toMatch(/visibilitychange/);
  });
});

describe('WebxdcBook', () => {
  it('persists instances and only moves the last serial forward', () => {
    const file = path.join(tmp, 'book.json');
    const book = new WebxdcBook(file);
    book.addInstance({ msgId: 7, platformId: 'dc:10', app: 'nanoclaw', createdAt: 'now', lastSerial: 0 });
    book.setLastSerial(7, 5);
    book.setLastSerial(7, 3);
    const again = new WebxdcBook(file);
    expect(again.instance(7)?.lastSerial).toBe(5);
    expect(again.instance(8)).toBeUndefined();
  });

  it('keeps pending questions until answered', () => {
    const book = new WebxdcBook(path.join(tmp, 'book.json'));
    book.addQuestion({ questionId: 'q', msgId: 7, title: 'T', options: [] });
    expect(book.question('q')?.msgId).toBe(7);
    book.removeQuestion('q');
    expect(book.question('q')).toBeUndefined();
  });
});

describe('parseAppUpdate', () => {
  it("reads the app's messages, actions and pings", () => {
    expect(parseAppUpdate({ type: 'user_message', content: 'hi' })).toEqual({ kind: 'message', text: 'hi' });
    expect(parseAppUpdate({ type: 'action', actionId: 'a', value: 'Yes', surfaceId: 's' })).toEqual({
      kind: 'action',
      actionId: 'a',
      value: 'Yes',
      surfaceId: 's',
    });
    expect(parseAppUpdate({ type: 'ping' })).toEqual({ kind: 'ping' });
  });

  it("ignores the bot's own updates (the echo) and anything malformed", () => {
    for (const type of ['message', 'interactive', 'resolved', 'status', 'meta', 'clear', 'user_echo']) {
      expect(parseAppUpdate({ type, content: 'x' })).toBeNull();
    }
    expect(parseAppUpdate({ type: 'user_message', content: '   ' })).toBeNull();
    expect(parseAppUpdate('hello')).toBeNull();
    expect(parseAppUpdate(null)).toBeNull();
  });
});

describe('statusUpdate', () => {
  it('notifies for content, with a short gist, and not for status lines', () => {
    const long = 'word '.repeat(40);
    const msg = JSON.parse(
      statusUpdate({ type: 'message', id: 'i', title: 'Andy', content: long, timestamp: 1 }, 'Andy'),
    );
    expect(msg.notify['*'].length).toBeLessThanOrEqual(86);
    expect(msg.notify['*']).toMatch(/^Andy: word word .*…$/);
    expect(JSON.parse(statusUpdate({ type: 'status', text: 'thinking' }, 'Andy')).notify).toBeUndefined();
  });
});

describe('threads and images', () => {
  it('maps app instances to xdc: threads and back', () => {
    expect(instanceOfThread(xdcThread(42))).toBe(42);
    expect(instanceOfThread(null)).toBeNull();
    expect(instanceOfThread('slack-thread')).toBeNull();
    expect(instanceOfThread('xdc:abc')).toBeNull();
  });

  it('inlines small images only', () => {
    expect(inlineImage('a.png', Buffer.from('x'))).toMatch(/^!\[a\.png\]\(data:image\/png;base64,/);
    expect(inlineImage('a.pdf', Buffer.from('x'))).toBeNull();
    expect(inlineImage('big.jpg', Buffer.alloc(1024 * 1024 + 1))).toBeNull();
  });
});
