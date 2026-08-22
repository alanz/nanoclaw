/**
 * DeltaChat sender identity.
 *
 * DeltaChat core (≥2.x) keys contacts by their OpenPGP fingerprint; the
 * contact's `address` is only the relay the latest message arrived through,
 * and changes whenever the sender uses another relay (multi-transport).
 * Identity must therefore follow the fingerprint, not the address.
 *
 * The JSON-RPC API exposes the fingerprint only inside the human-readable
 * text of `get_contact_encryption_info`. Its layout is fixed by core
 * (`Contact::get_encrinfo` / `cat_fingerprint` in chatmail/core src/contact.rs):
 *
 *   <stock e2ee line>
 *   <stock "Fingerprints">:
 *
 *   <name> (<addr>):
 *   ABCD ABCD ABCD ABCD ABCD
 *   ABCD ABCD ABCD ABCD ABCD
 *
 *   <self name> (<self addr>):
 *   ...
 *
 *   Relays:
 *   a@relay-one.example
 *   b@relay-two.example
 *
 * Only the `(<addr>):` suffix and the hex block are relied on; the stock
 * strings are localisable and are ignored.
 */

const FINGERPRINT_RE = /^[0-9A-F]{40}$/;

/** User-id handle for a fingerprint-identified sender: `fp:<40 hex>`. */
export function fingerprintHandle(fingerprint: string): string {
  return `fp:${fingerprint}`;
}

/** The fingerprint inside an `fp:` handle, or null for any other handle. */
export function fingerprintFromHandle(handle: string): string | null {
  const m = handle.match(/^fp:([0-9A-F]{40})$/);
  return m ? m[1] : null;
}

/**
 * Extract the fingerprint listed for `addr` from encryption-info text.
 * Returns null when the block is missing or does not hold exactly 40 hex
 * characters — callers must then fall back rather than guess.
 */
export function parseContactFingerprint(encInfo: string, addr: string): string | null {
  const lines = encInfo.split('\n');
  const header = `(${addr.toLowerCase()}):`;
  const start = lines.findIndex((l) => l.trim().toLowerCase().endsWith(header));
  if (start < 0) return null;

  let hex = '';
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    hex += line.replace(/\s+/g, '');
  }
  hex = hex.toUpperCase();
  return FINGERPRINT_RE.test(hex) ? hex : null;
}

/** Relay addresses published in the contact's key (the `Relays:` section), lowercased. */
export function parseRelays(encInfo: string): string[] {
  const lines = encInfo.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Relays:');
  if (start < 0) return [];
  const relays: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t === '') break;
    if (t.includes('@')) relays.push(t.toLowerCase());
  }
  return relays;
}
