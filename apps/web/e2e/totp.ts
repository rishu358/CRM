import { createHmac } from 'node:crypto';

/**
 * The six-digit code an authenticator app shows for the base32 key the setup page displays
 * (RFC 4226 / RFC 6238, HMAC-SHA1, 30-second steps). Deliberately not the API's own code: a test must
 * not ask the code under test what the right answer is. Mirrors `apps/api/src/testing/totp-reference.ts`.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Bytes(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of text.replaceAll(/[\s=]/g, '').toUpperCase()) {
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

export function authenticatorCode(base32Key: string): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', base32Bytes(base32Key)).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** 6).padStart(6, '0');
}
