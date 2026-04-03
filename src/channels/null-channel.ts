import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

export const NULL_CHANNEL_JID_PREFIX = 'specialist:';

export class NullChannel implements Channel {
  name = 'null-channel';

  async connect(): Promise<void> {
    // No I/O — resolves immediately
  }

  async disconnect(): Promise<void> {
    // No-op
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // Messages to specialist JIDs are silently discarded
  }

  isConnected(): boolean {
    return true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(NULL_CHANNEL_JID_PREFIX);
  }
}

export function makeSpecialistJid(taskId: string): string {
  return NULL_CHANNEL_JID_PREFIX + taskId;
}

registerChannel('null-channel', (_opts: ChannelOpts) => new NullChannel());
