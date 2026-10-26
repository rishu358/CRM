import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { base32 } from '@better-auth/utils/base32';
import { KeyRing } from './key-ring.js';

/**
 * TOTP second factors (MVP_SPEC M1, ADR-0017).
 *
 * RFC 6238 on top of RFC 4226: HMAC-SHA1 over the 30-second step counter, dynamic truncation, six
 * digits. It is written out here (about twenty lines over `node:crypto`) rather than taken from a
 * library because the library's `createOTP(secret)` takes the secret as the *text* of the key, while
 * every authenticator app takes the base32 the person types or scans as the *bytes* of the key. The
 * two only agree if the text is itself the key, which is not what we show. That mismatch made every
 * code from a typed key fail (pilot simulation F1, ADR-0057).
 *
 * ## The key
 *
 * 160 random bits (RFC 4226 §4), shown to the person as RFC 4648 base32 and carried in the
 * `otpauth://` link as the same base32. The server decodes it to bytes before it computes anything,
 * exactly as an app does.
 *
 * ## Secrets at rest
 *
 * A TOTP secret is a second password: anyone holding it can generate valid
 * codes forever. So it is encrypted with `AUTH_SECRET` (through the key ring, which
 * records which key wrote each value, ADR-0049) before it reaches the
 * database, which means a leaked database alone does not defeat MFA — the
 * attacker also needs the application's secret, which lives somewhere else
 * entirely (CLAUDE.md §5.8).
 *
 * The plain text that gets encrypted says how to read the key: `base32:<key>` is the standard form
 * written since the fix. A value with no marker was written before it, when the characters of the
 * base32 text were used as the key and the QR link carried the base32 of that text. Those people's
 * apps hold exactly that, so they keep working, each by its own rule and only by it (never both for
 * one person), until they set two-factor up again.
 *
 * ## The verification window
 *
 * One step either side. Zero rejects anyone whose phone clock drifts by a few
 * seconds, which is most phones; wider turns each code into a minutes-long
 * guessing target. One step is the usual compromise and what RFC 6238 §5.2
 * describes.
 */
export const TOTP_PROVIDER = 'TOTP_PROVIDER';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
const TOTP_WINDOW = 1;
const STORED_PREFIX = 'base32:';

export interface TotpProvider {
  /** A fresh base32 secret, in the clear. Shown once, then encrypted. */
  generateSecret(): string;
  /** `otpauth://totp/...` for the QR code. Carries the same base32 key as `secret`. */
  provisioningUrl(secret: string, issuer: string, account: string): string;
  /** The plain text to encrypt and store for a secret from `generateSecret`. */
  toStoredSecret(secret: string): string;
  /** `storedSecret` is what `decryptSecret` returns for a value written from `toStoredSecret`. */
  verify(storedSecret: string, code: string): Promise<boolean>;
  encryptSecret(secret: string): Promise<string>;
  decryptSecret(ciphertext: string): Promise<string>;
}

@Injectable()
export class BetterAuthTotpProvider implements TotpProvider {
  constructor(@Inject(KeyRing) private readonly keys: KeyRing) {}

  /** 160 bits, as RFC 4226 §4 requires for HMAC-SHA1. */
  generateSecret(): string {
    return base32.encode(randomBytes(20), { padding: false });
  }

  provisioningUrl(secret: string, issuer: string, account: string): string {
    const parameters = new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: String(TOTP_DIGITS),
      period: String(TOTP_PERIOD_SECONDS),
    });
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${parameters.toString()}`;
  }

  toStoredSecret(secret: string): string {
    return `${STORED_PREFIX}${secret}`;
  }

  verify(storedSecret: string, code: string): Promise<boolean> {
    return Promise.resolve(this.check(storedSecret, code));
  }

  private check(storedSecret: string, code: string): boolean {
    // Users type codes with a space in the middle, because that is how every
    // authenticator app displays them.
    const normalised = code.replaceAll(/\s/g, '');
    if (!/^\d{6}$/.test(normalised)) return false;

    let key: Uint8Array;
    try {
      key = keyBytes(storedSecret);
    } catch {
      return false;
    }
    if (key.length === 0) return false;

    const counter = Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000));
    // Every step in the window is computed and compared, whatever matched first, so the time taken
    // does not say which step a code was from.
    let matched = false;
    for (let step = -TOTP_WINDOW; step <= TOTP_WINDOW; step += 1) {
      const expected = Buffer.from(hotp(key, counter + step));
      matched = timingSafeEqual(expected, Buffer.from(normalised)) || matched;
    }
    return matched;
  }

  async encryptSecret(secret: string): Promise<string> {
    return this.keys.encrypt(secret);
  }

  async decryptSecret(ciphertext: string): Promise<string> {
    return this.keys.decrypt(ciphertext);
  }
}

/** The bytes an authenticator app holds for a stored secret (see "Secrets at rest"). */
function keyBytes(storedSecret: string): Uint8Array {
  if (storedSecret.startsWith(STORED_PREFIX)) {
    return base32.decode(storedSecret.slice(STORED_PREFIX.length));
  }
  return Buffer.from(storedSecret, 'utf8');
}

/** RFC 4226 §5.3, HMAC-SHA1, six digits. */
function hotp(key: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}
