import { createHmac } from 'node:crypto';

/**
 * A second, independent TOTP implementation for tests (RFC 4226 / RFC 6238, HMAC-SHA1).
 *
 * It exists so that a test never asks the code under test what the right answer is: this is what an
 * authenticator app does with the key a person types or scans. It reads the key as RFC 4648 base32
 * (the form the setup page shows and the `otpauth://` link carries), not as the text of the key.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Bytes(text: string): Buffer {
  const clean = text.replaceAll(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new Error(`not base32: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Text(bytes: Uint8Array): string {
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

/** The HOTP value of RFC 4226 §5.3 for a raw key. */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The six-digit code an authenticator app shows for a base32 key, `stepOffset` 30-second steps away
 * from `atMs` (default: now).
 */
export function authenticatorCode(
  base32Key: string,
  { atMs = Date.now(), stepOffset = 0, digits = 6 } = {},
): string {
  const counter = Math.floor(atMs / 30_000) + stepOffset;
  return hotp(base32Bytes(base32Key), counter, digits);
}

/** The `secret` parameter of an `otpauth://` link: what a scanned QR code puts in the app. */
export function secretFromOtpauthUrl(url: string): string {
  const secret = new URL(url).searchParams.get('secret');
  if (secret === null) throw new Error('no secret in the otpauth link');
  return secret;
}
