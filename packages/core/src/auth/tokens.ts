import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time tokens for email verification, password reset and the MFA hand-off.
 *
 * Same shape and same reasoning as session tokens (`../sessions`): 32 bytes of
 * CSPRNG output, and only the SHA-256 is stored. A reset token in a database
 * backup is a working password reset for every account in it, so the column
 * holds a digest and the lookup is by digest.
 *
 * SHA-256 rather than a slow hash is right here for the same reason it is for
 * sessions: 256 bits of entropy has nothing to brute force, and these are
 * checked on request paths that must stay fast.
 */
export function generateOneTimeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOneTimeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** How long each kind of token stays valid. */
export const TOKEN_TTL_SECONDS = {
  /** Long enough to survive a mail queue and a distracted afternoon. */
  email_verification: 24 * 60 * 60,
  /** Short: a reset link is a password. */
  password_reset: 60 * 60,
  /** Only has to survive typing six digits off a phone. */
  mfa_challenge: 5 * 60,
} as const;

export type TokenPurpose = keyof typeof TOKEN_TTL_SECONDS;

/**
 * Compare two secrets without leaking where they differ.
 *
 * Returns false for differing lengths rather than throwing, because
 * `timingSafeEqual` rejects mismatched buffers outright and the length of a
 * fixed-format secret is not what we are hiding.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
