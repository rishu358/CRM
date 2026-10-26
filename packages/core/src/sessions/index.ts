import { createHash, randomBytes } from 'node:crypto';

/**
 * Session token generation and hashing (ADR-0014).
 *
 * Lives in core so the API and the seed agree byte for byte. Two
 * implementations of "how a session token is stored" is one more than can be
 * kept correct, and the failure mode is silent: tokens that simply never match.
 */

/** 32 bytes of CSPRNG output, base64url encoded. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What the database stores. The token itself is never persisted, so a stolen
 * backup yields no usable sessions.
 *
 * SHA-256 rather than a slow password hash is right here: the input is 32
 * random bytes, so there is no low entropy to defend, and this runs on the hot
 * path of every authenticated request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
