import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { emailIdFromReplyLocal } from './reply.js';

// A subpath of its own (`@crm/core/email-reply-address`), not part of the barrel: this file needs
// `node:crypto`, and the barrel is bundled into the browser.

/**
 * Signing and checking the reply address (ADR-0077), the same way the unsubscribe token is signed (ADR-0076): a
 * key derived (HKDF) from the unsubscribe secret under a label of its own, so no new secret, and a signature of
 * the email id that does not expire, because an address printed in a sent email must keep working.
 *
 * The signature is 128 bits (the first 16 bytes of an HMAC-SHA256), written as 26 lower-case base32 characters so
 * the whole local part fits the 64 a mail address allows and survives a mail system changing its case. Base32 of
 * 128 bits has spare bits in its last character, so two different strings could decode to the same bytes; the
 * check therefore compares the **strings**, never decoded bytes, and a non-canonical one is refused.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function deriveReplySecret(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'crm:email-reply-address:v1', 32));
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The local part of the reply address of the email with this id. */
export function issueReplyToken(key: Buffer, emailId: string): string {
  if (!UUID.test(emailId)) throw new TypeError('A reply address is made for an email id');
  const mac = createHmac('sha256', key).update(`v1.reply.${emailId}`).digest().subarray(0, 16);
  return `r.${emailId.replaceAll('-', '')}.${base32(mac)}`;
}

/**
 * The id of the email a local part was issued for, or null for anything else: the wrong shape, a changed id, a
 * signature made with a key this process does not hold. Every key is tried and the comparison does not stop at
 * the first differing byte.
 */
export function verifyReplyToken(keys: readonly Buffer[], local: unknown): string | null {
  if (typeof local !== 'string') return null;
  const emailId = emailIdFromReplyLocal(local);
  if (emailId === null) return null;
  const given = Buffer.from(local, 'utf8');
  let matched = false;
  for (const key of keys) {
    const expected = Buffer.from(issueReplyToken(key, emailId), 'utf8');
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  return matched ? emailId : null;
}
