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

import { describe, it, vi } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// TODO: uncomment when src/channels/null-channel.ts is implemented
// import { registerChannel } from './registry.js';
// import './null-channel.js';
// import { NullChannel, NULL_CHANNEL_JID_PREFIX } from './null-channel.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('NullChannel config', () => {
  // config_default.jid_prefix
  it.todo('jid_prefix defaults to "specialist:"');
});

// ---------------------------------------------------------------------------
// Rule: NullChannelRegistered
// ---------------------------------------------------------------------------

describe('NullChannelRegistered', () => {
  // rule_success.NullChannelRegistered
  it.todo(
    'NullChannel registers with the channel registry under the "null-channel" name at module load',
  );

  it.todo(
    'registered channel advertises ownership of the "specialist:" JID prefix via ownsJid',
  );

  it.todo(
    'registered channel satisfies the full Channel interface (connect, sendMessage, isConnected, ownsJid, disconnect)',
  );

  // rule_success — no authentication, no connection lifecycle
  it.todo('connect() resolves immediately without performing any I/O');

  it.todo('isConnected() returns true after connect()');

  it.todo('disconnect() resolves immediately without error');
});

// ---------------------------------------------------------------------------
// Rule: SyntheticJidAssigned
// ---------------------------------------------------------------------------

describe('SyntheticJidAssigned', () => {
  // rule_success.SyntheticJidAssigned
  it.todo('synthetic JID for a task is "specialist:" + task_id');

  it.todo('two different task IDs produce different synthetic JIDs');

  it.todo('synthetic JID always starts with the configured prefix');

  // derived — JID format
  it.todo('synthetic JID contains no spaces or invalid JID characters');
});

// ---------------------------------------------------------------------------
// Rule: SendMessageDiscarded
// ---------------------------------------------------------------------------

describe('SendMessageDiscarded', () => {
  // rule_success.SendMessageDiscarded — message to specialist: JID is silently dropped
  it.todo('sendMessage() with a "specialist:" JID resolves without error');

  it.todo(
    'sendMessage() with a "specialist:" JID produces no side effects (no callbacks invoked)',
  );

  it.todo('sendMessage() with a "specialist:" JID does not throw');

  // rule_failure.SendMessageDiscarded — non-specialist JID is not handled
  it.todo(
    'ownsJid() returns false for a JID that does not start with "specialist:"',
  );

  it.todo('ownsJid() returns true for a JID that starts with "specialist:"');

  // edge case — prefix boundary
  it.todo(
    'ownsJid() returns false for exactly "specialis" (one character short of prefix)',
  );

  it.todo('ownsJid() returns false for an empty string');
});

// ---------------------------------------------------------------------------
// Invariant: NoInboundMessages
// ---------------------------------------------------------------------------

describe('NoInboundMessages invariant', () => {
  // invariant.NoInboundMessages — NullChannel never delivers inbound messages
  it.todo(
    'the onMessage callback is never invoked by NullChannel after connect()',
  );

  it.todo('NullChannel does not call onChatMetadata at any point');
});

// ---------------------------------------------------------------------------
// Invariant: JidPrefixOwnership
// ---------------------------------------------------------------------------

describe('JidPrefixOwnership invariant', () => {
  // invariant.JidPrefixOwnership — every JID owned by NullChannel uses the prefix
  it.todo('ownsJid returns true only for JIDs starting with "specialist:"');

  it.todo(
    'ownsJid returns false for JIDs starting with other channel prefixes (e.g. "emacs:", "telegram:")',
  );
});

// ---------------------------------------------------------------------------
// Scenario: full specialist task slot lifecycle
// ---------------------------------------------------------------------------

describe('specialist container slot lifecycle (scenario)', () => {
  // scenario.happy_path — specialist task queued → synthetic JID → routed through GroupQueue
  it.todo(
    'a synthetic JID for a queued specialist task is accepted by GroupQueue as a normal groupJid',
  );

  it.todo(
    'any message routed back to a specialist synthetic JID via the channel layer is silently dropped',
  );
});
