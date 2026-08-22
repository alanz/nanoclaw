import { describe, expect, it } from 'vitest';

import {
  fingerprintFromHandle,
  fingerprintHandle,
  parseContactFingerprint,
  parseRelays,
} from './deltachat-identity.js';

const FP_ALAN = '0123456789ABCDEF0123456789ABCDEF01234567';
const FP_BOT = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98';

/** Human-readable fingerprint exactly as core's `Fingerprint::human_readable` lays it out. */
function human(fp: string): string {
  return `${fp.slice(0, 20).replace(/(.{4})(?!$)/g, '$1 ')}\n${fp.slice(20).replace(/(.{4})(?!$)/g, '$1 ')}`;
}

/** Encryption-info text in core's `get_encrinfo` layout (contact block first when its addr sorts before ours). */
function encInfo(opts: { contactAddr: string; relays?: string[]; contactFirst?: boolean }): string {
  const contact = `\n\nalanz (${opts.contactAddr}):\n${human(FP_ALAN)}`;
  const self = `\n\nMe (zf846nqui@nine.testrun.org):\n${human(FP_BOT)}`;
  let text = 'Messages are end-to-end encrypted.\nFingerprints:';
  text += opts.contactFirst === false ? self + contact : contact + self;
  if (opts.relays) text += `\n\nRelays:\n${opts.relays.join('\n')}`;
  return text;
}

describe('parseContactFingerprint', () => {
  it('extracts the contact block, not our own, whichever comes first', () => {
    expect(parseContactFingerprint(encInfo({ contactAddr: 'x0edwc7z1@chtml.ca' }), 'x0edwc7z1@chtml.ca')).toBe(FP_ALAN);
    expect(
      parseContactFingerprint(
        encInfo({ contactAddr: 'x0edwc7z1@chtml.ca', contactFirst: false }),
        'x0edwc7z1@chtml.ca',
      ),
    ).toBe(FP_ALAN);
  });

  it('matches the address case-insensitively', () => {
    expect(parseContactFingerprint(encInfo({ contactAddr: 'Alan@Example.org' }), 'alan@example.org')).toBe(FP_ALAN);
  });

  it('returns null when the address has no block', () => {
    expect(parseContactFingerprint(encInfo({ contactAddr: 'a@example.org' }), 'b@example.org')).toBeNull();
  });

  it('returns null for the no-encryption text or a malformed fingerprint', () => {
    expect(parseContactFingerprint('No encryption.', 'a@example.org')).toBeNull();
    expect(parseContactFingerprint('Fingerprints:\n\nalan (a@example.org):\nABCD EFGH', 'a@example.org')).toBeNull();
  });
});

describe('parseRelays', () => {
  it('lists the relays section, lowercased', () => {
    const text = encInfo({
      contactAddr: 'x0edwc7z1@chtml.ca',
      relays: ['x0edwc7z1@chtml.ca', 'ASM78QISG@nine.testrun.org', 'htt7u2o7l@nibblehole.com'],
    });
    expect(parseRelays(text)).toEqual(['x0edwc7z1@chtml.ca', 'asm78qisg@nine.testrun.org', 'htt7u2o7l@nibblehole.com']);
  });

  it('is empty when there is no relays section', () => {
    expect(parseRelays(encInfo({ contactAddr: 'a@example.org' }))).toEqual([]);
  });
});

describe('fingerprint handles', () => {
  it('round-trips', () => {
    expect(fingerprintFromHandle(fingerprintHandle(FP_ALAN))).toBe(FP_ALAN);
  });

  it('rejects addresses and short hex', () => {
    expect(fingerprintFromHandle('alan@example.org')).toBeNull();
    expect(fingerprintFromHandle('fp:ABCD')).toBeNull();
  });
});
