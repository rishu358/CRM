import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { unsubscribeEmailIdOf } from './unsubscribe.js';

// A subpath of its own (`@crm/core/email-unsubscribe-token`), not part of the barrel: this file needs
// `node:crypto`, and the barrel is bundled into the browser.

/**
 * Signing and checking the unsubscribe token (ADR-0076).
 *
 * The key is derived from the instance's existing auth secret under a fixed label, so the feature adds no
 * secret and no environment variable. Nothing is stored to check a token: the signature over the email id is
 * the whole proof, and a token never expires, because a link in an old email must still work.
 *
 * Because of that, rotating `AUTH_SECRET` would end every link already sent unless the old secret is still
 * accepted: `verifyUnsubscribeToken` takes every key the process holds (the current one and
 * `AUTH_SECRET_PREVIOUS`), and docs/SECRETS.md says what that means for dropping an old key.
 */
export function deriveUnsubscribeSecret(authSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', authSecret, Buffer.alloc(0), 'crm:email-unsubscribe:v1', 32),
  );
}

function signature(secret: Buffer, emailId: string): Buffer {
  return createHmac('sha256', secret).update(`v1.unsubscribe.${emailId}`).digest();
}

/** The token to put in the email with this id. */
export function issueUnsubscribeToken(secret: Buffer, emailId: string): string {
  return `v1.${emailId}.${signature(secret, emailId).toString('base64url')}`;
}

/**
 * The id of the email a token was issued for, or null for anything else: the wrong shape, a changed id, a
 * signature made with a key this process does not hold. Every key is tried, and the comparison does not stop at
 * the first differing byte.
 */
export function verifyUnsubscribeToken(secrets: readonly Buffer[], token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const emailId = unsubscribeEmailIdOf(token);
  if (emailId === null) return null;
  const given = Buffer.from(token.slice(token.lastIndexOf('.') + 1), 'base64url');
  let matched = false;
  for (const secret of secrets) {
    const expected = signature(secret, emailId);
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  return matched ? emailId : null;
}
