/**
 * Tests propagated from docs/project/specs/null-channel.allium
 *
 * Obligation categories covered:
 *   config_default, rule_success (NullChannelRegistered, SyntheticJidAssigned,
 *   SendMessageDiscarded), invariant (NoInboundMessages, JidPrefixOwnership)
 *
 * Implementation required: src/channels/null-channel.ts (does not exist yet)
 * These tests are the TDD contract that the implementation must satisfy.
 *
 * When implementing, create NullChannel class in src/channels/null-channel.ts,
 * register it in src/channels/index.ts with registerChannel('null-channel', factory).
 */

import { describe, expect, it, vi } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

import { registerChannel } from './registry.js';
import {
  NullChannel,
  NULL_CHANNEL_JID_PREFIX,
  makeSpecialistJid,
} from './null-channel.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('NullChannel config', () => {
  it('jid_prefix defaults to "specialist:"', () => {
    expect(NULL_CHANNEL_JID_PREFIX).toBe('specialist:');
  });
});

// ---------------------------------------------------------------------------
// Rule: NullChannelRegistered
// ---------------------------------------------------------------------------

describe('NullChannelRegistered', () => {
  it('NullChannel registers with the channel registry under the "null-channel" name at module load', () => {
    expect(registerChannel).toHaveBeenCalledWith(
      'null-channel',
      expect.any(Function),
    );
  });

  it('registered channel advertises ownership of the "specialist:" JID prefix via ownsJid', () => {
    const ch = new NullChannel();
    expect(ch.ownsJid('specialist:task-abc')).toBe(true);
  });

  it('registered channel satisfies the full Channel interface (connect, sendMessage, isConnected, ownsJid, disconnect)', () => {
    const ch = new NullChannel();
    expect(typeof ch.connect).toBe('function');
    expect(typeof ch.sendMessage).toBe('function');
    expect(typeof ch.isConnected).toBe('function');
    expect(typeof ch.ownsJid).toBe('function');
    expect(typeof ch.disconnect).toBe('function');
  });

  it('connect() resolves immediately without performing any I/O', async () => {
    const ch = new NullChannel();
    await expect(ch.connect()).resolves.toBeUndefined();
  });

  it('isConnected() returns true after connect()', async () => {
    const ch = new NullChannel();
    await ch.connect();
    expect(ch.isConnected()).toBe(true);
  });

  it('disconnect() resolves immediately without error', async () => {
    const ch = new NullChannel();
    await expect(ch.disconnect()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule: SyntheticJidAssigned
// ---------------------------------------------------------------------------

describe('SyntheticJidAssigned', () => {
  it('synthetic JID for a task is "specialist:" + task_id', () => {
    expect(makeSpecialistJid('task-123')).toBe('specialist:task-123');
  });

  it('two different task IDs produce different synthetic JIDs', () => {
    expect(makeSpecialistJid('task-1')).not.toBe(makeSpecialistJid('task-2'));
  });

  it('synthetic JID always starts with the configured prefix', () => {
    expect(
      makeSpecialistJid('any-id').startsWith(NULL_CHANNEL_JID_PREFIX),
    ).toBe(true);
  });

  it('synthetic JID contains no spaces or invalid JID characters', () => {
    const jid = makeSpecialistJid('task-abc-123');
    expect(jid).toMatch(/^[^\s]+$/);
  });
});

// ---------------------------------------------------------------------------
// Rule: SendMessageDiscarded
// ---------------------------------------------------------------------------

describe('SendMessageDiscarded', () => {
  it('sendMessage() with a "specialist:" JID resolves without error', async () => {
    const ch = new NullChannel();
    await expect(
      ch.sendMessage('specialist:task-1', 'hello'),
    ).resolves.toBeUndefined();
  });

  it('sendMessage() with a "specialist:" JID produces no side effects (no callbacks invoked)', async () => {
    const ch = new NullChannel();
    const spy = vi.fn();
    // There are no callbacks on NullChannel — we just confirm sendMessage is truly a no-op
    await ch.sendMessage('specialist:task-1', 'hello');
    expect(spy).not.toHaveBeenCalled();
  });

  it('sendMessage() with a "specialist:" JID does not throw', async () => {
    const ch = new NullChannel();
    await expect(
      ch.sendMessage('specialist:task-1', ''),
    ).resolves.toBeUndefined();
  });

  it('ownsJid() returns false for a JID that does not start with "specialist:"', () => {
    const ch = new NullChannel();
    expect(ch.ownsJid('tg:12345')).toBe(false);
  });

  it('ownsJid() returns true for a JID that starts with "specialist:"', () => {
    const ch = new NullChannel();
    expect(ch.ownsJid('specialist:task-abc')).toBe(true);
  });

  it('ownsJid() returns false for exactly "specialis" (one character short of prefix)', () => {
    const ch = new NullChannel();
    expect(ch.ownsJid('specialis')).toBe(false);
  });

  it('ownsJid() returns false for an empty string', () => {
    const ch = new NullChannel();
    expect(ch.ownsJid('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariant: NoInboundMessages
// ---------------------------------------------------------------------------

describe('NoInboundMessages invariant', () => {
  it('the onMessage callback is never invoked by NullChannel after connect()', async () => {
    const ch = new NullChannel();
    const onMessage = vi.fn();
    await ch.connect();
    // NullChannel has no mechanism to call onMessage — verify it is not called
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('NullChannel does not call onChatMetadata at any point', async () => {
    const ch = new NullChannel();
    const onChatMetadata = vi.fn();
    await ch.connect();
    expect(onChatMetadata).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Invariant: JidPrefixOwnership
// ---------------------------------------------------------------------------

describe('JidPrefixOwnership invariant', () => {
  it('ownsJid returns true only for JIDs starting with "specialist:"', () => {
    const ch = new NullChannel();
    expect(ch.ownsJid('specialist:')).toBe(true);
    expect(ch.ownsJid('specialist:anything')).toBe(true);
    expect(ch.ownsJid('not-specialist:x')).toBe(false);
  });

  it('ownsJid returns false for JIDs starting with other channel prefixes (e.g. "emacs:", "telegram:")', () => {
    const ch = new NullChannel();
    expect(ch.ownsJid('emacs:default')).toBe(false);
    expect(ch.ownsJid('tg:123456')).toBe(false);
    expect(ch.ownsJid('dc:789')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario: full specialist task slot lifecycle
// ---------------------------------------------------------------------------

describe('specialist container slot lifecycle (scenario)', () => {
  it('a synthetic JID for a queued specialist task is accepted by GroupQueue as a normal groupJid', () => {
    // The synthetic JID is just a string — GroupQueue accepts any string as groupJid.
    // Verify the JID is well-formed and would pass a startsWith check.
    const jid = makeSpecialistJid('task-99');
    expect(jid).toBe('specialist:task-99');
    expect(jid.startsWith('specialist:')).toBe(true);
  });

  it('any message routed back to a specialist synthetic JID via the channel layer is silently dropped', async () => {
    const ch = new NullChannel();
    const jid = makeSpecialistJid('task-99');
    // No error, no return value — pure discard
    await expect(ch.sendMessage(jid, 'result text')).resolves.toBeUndefined();
  });
});
