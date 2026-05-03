/**
 * Null channel — a virtual channel with no messaging platform backing.
 *
 * Every specialist task session needs a MessagingGroup (sessions.allium
 * requires messaging_group != null for non-agent-shared sessions). Rather
 * than carrying a real platform reference, specialist sessions all point to a
 * single singleton MessagingGroup with channel_type = "null_channel". Per-task
 * isolation comes from thread_id = task.id, not from a per-task chat ID.
 *
 * The adapter:
 *   - creates the singleton MessagingGroup on first startup (idempotent)
 *   - always reports isConnected() = true (no external service to ping)
 *   - silently no-ops deliver() — specialist results route back through the
 *     specialists routing module, never as outbound platform messages
 *   - accepts no inbound traffic (NoInboundFromNullChannel invariant)
 */

import { createMessagingGroup, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

export const NULL_CHANNEL_TYPE = 'null_channel';
export const NULL_CHANNEL_PLATFORM_ID = 'specialist';

let cachedNullMgId: string | null = null;

/**
 * Returns the id of the singleton null-channel MessagingGroup.
 * Throws if called before the null-channel adapter has been set up and the row
 * doesn't exist in the DB — this should never happen in normal operation since
 * channels are initialised before specialist tasks can be dispatched.
 */
export function getNullMessagingGroupId(): string {
  if (cachedNullMgId) return cachedNullMgId;
  const mg = getMessagingGroupByPlatform(NULL_CHANNEL_TYPE, NULL_CHANNEL_PLATFORM_ID);
  if (!mg) {
    throw new Error(
      'Null channel MessagingGroup not found — the null-channel adapter must be ' +
        'initialised before specialist sessions can be created',
    );
  }
  cachedNullMgId = mg.id;
  return cachedNullMgId;
}

function createAdapter(): ChannelAdapter {
  return {
    name: 'null-channel',
    channelType: NULL_CHANNEL_TYPE,
    supportsThreads: false,

    async setup(_config: ChannelSetup): Promise<void> {
      const existing = getMessagingGroupByPlatform(NULL_CHANNEL_TYPE, NULL_CHANNEL_PLATFORM_ID);
      if (existing) {
        cachedNullMgId = existing.id;
        return;
      }
      const id = `mg-null-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createMessagingGroup({
        id,
        channel_type: NULL_CHANNEL_TYPE,
        platform_id: NULL_CHANNEL_PLATFORM_ID,
        name: 'Specialist Tasks (null channel)',
        is_group: 0,
        unknown_sender_policy: 'strict',
        created_at: new Date().toISOString(),
      });
      cachedNullMgId = id;
      log.info('Null channel singleton MessagingGroup created', { id });
    },

    async teardown(): Promise<void> {},

    isConnected(): boolean {
      return true;
    },

    async deliver(
      _platformId: string,
      _threadId: string | null,
      _message: OutboundMessage,
    ): Promise<string | undefined> {
      return undefined;
    },
  };
}

registerChannelAdapter('null-channel', { factory: createAdapter });
