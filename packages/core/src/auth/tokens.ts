import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUuid, type Uuid } from '../ids/index.js';

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
  /** Seven days, fixed by MVP_SPEC M2. Long enough to survive a holiday. */
  team_invite: 7 * 24 * 60 * 60,
} as const;

export type TokenPurpose = keyof typeof TOKEN_TTL_SECONDS;

/**
 * Invitation tokens: a workspace id, a dot, and an ordinary one-time secret.
 *
 * The prefix is a **routing hint, never an authorization**. An invitation is
 * tenant-owned data behind RLS, so redeeming one means opening a transaction
 * for some tenant — and the tenant cannot be known until the token has been
 * looked up, which is the same chicken-and-egg a password reset never has.
 * Carrying the workspace id in the link breaks it without widening any
 * database role's reach.
 *
 * Nothing is trusted from the prefix. The row is still found by the digest of
 * the **whole** token, inside that tenant's RLS context, so a caller who edits
 * the prefix simply selects a context in which their secret matches nothing.
 * A caller who guesses a workspace id gains exactly nothing without a secret.
 */
const INVITATION_TOKEN_SEPARATOR = '.';

export function generateInvitationToken(tenantId: string): string {
  return `${tenantId}${INVITATION_TOKEN_SEPARATOR}${generateOneTimeToken()}`;
}

/**
 * Pull the workspace id out of an invitation token.
 *
 * Returns null for anything malformed so the caller answers "this link is
 * invalid" rather than passing a bad value towards `SET LOCAL app.tenant_id`.
 */
export function parseInvitationToken(token: string): { tenantId: Uuid; secret: string } | null {
  const separator = token.indexOf(INVITATION_TOKEN_SEPARATOR);
  if (separator <= 0) return null;

  const tenantId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!isUuid(tenantId)) return null;
  // 32 bytes of base64url is 43 characters; anything shorter is not ours.
  if (secret.length < 43) return null;

  return { tenantId, secret };
}

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
