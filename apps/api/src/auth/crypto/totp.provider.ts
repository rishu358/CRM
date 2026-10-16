import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';

/**
 * TOTP second factors (MVP_SPEC M1, ADR-0017).
 *
 * RFC 6238 via `@better-auth/utils/otp` — the same implementation Better Auth
 * uses for its own two-factor plugin. We supply the secret and the policy; the
 * HMAC, the time step and the counter arithmetic are not ours.
 *
 * ## Secrets at rest
 *
 * A TOTP secret is a second password: anyone holding it can generate valid
 * codes forever. So it is encrypted with `AUTH_SECRET` before it reaches the
 * database, which means a leaked database alone does not defeat MFA — the
 * attacker also needs the application's secret, which lives somewhere else
 * entirely (CLAUDE.md §5.8).
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

export interface TotpProvider {
  /** A fresh base32 secret, in the clear. Shown once, then encrypted. */
  generateSecret(): string;
  /** `otpauth://totp/...` for the QR code. */
  provisioningUrl(secret: string, issuer: string, account: string): string;
  verify(secret: string, code: string): Promise<boolean>;
  encryptSecret(secret: string): Promise<string>;
  decryptSecret(ciphertext: string): Promise<string>;
}

@Injectable()
export class BetterAuthTotpProvider implements TotpProvider {
  constructor(@Inject(API_ENV_TOKEN) private readonly env: ApiEnv) {}

  /** 160 bits, as RFC 4226 §4 requires for HMAC-SHA1. */
  generateSecret(): string {
    return base32.encode(randomBytes(20), { padding: false });
  }

  provisioningUrl(secret: string, issuer: string, account: string): string {
    return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS }).url(
      issuer,
      account,
    );
  }

  async verify(secret: string, code: string): Promise<boolean> {
    // Users type codes with a space in the middle, because that is how every
    // authenticator app displays them.
    const normalised = code.replaceAll(/\s/g, '');
    if (!/^\d{6}$/.test(normalised)) return false;

    try {
      return await createOTP(secret, {
        digits: TOTP_DIGITS,
        period: TOTP_PERIOD_SECONDS,
      }).verify(normalised, { window: TOTP_WINDOW });
    } catch {
      return false;
    }
  }

  async encryptSecret(secret: string): Promise<string> {
    return symmetricEncrypt({ key: this.env.AUTH_SECRET, data: secret });
  }

  async decryptSecret(ciphertext: string): Promise<string> {
    return symmetricDecrypt({ key: this.env.AUTH_SECRET, data: ciphertext });
  }
}
