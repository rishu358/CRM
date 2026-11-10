import { deriveReplySecret } from '@crm/core/email-reply-address';
import { deriveUnsubscribeSecret } from '@crm/core/email-unsubscribe-token';
import { previousAuthSecrets, previousUnsubscribeSecrets, type ApiEnv } from '../config/env.js';

/**
 * The keys the unsubscribe token (ADR-0076) and the reply address (ADR-0077) are signed and checked with.
 *
 * **With `EMAIL_UNSUBSCRIBE_SECRET` set** (production requires it) the keys are derived from that and only that:
 * a link or an address in an email sent last year must still work after the session secret is rotated, so they
 * have a secret of their own that is not rotated on a schedule. New tokens are signed with it; a token is checked
 * against it and every key in `EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS`, so an old key can be kept for as long as its
 * links matter. A token signed under any other key, `AUTH_SECRET` included, is refused.
 *
 * **With it unset** (development, tests, CI: production refuses to start) the key falls back to one derived
 * from `AUTH_SECRET`, so a local stack needs no extra setting. That fallback is what must never run in a real
 * deployment, and the production guard is what stops it.
 *
 * The two uses derive their keys under **different labels** from the same secret, so a token made for one is
 * worth nothing to the other.
 */
type KeyEnv = Pick<
  ApiEnv,
  | 'AUTH_SECRET'
  | 'AUTH_SECRET_PREVIOUS'
  | 'EMAIL_UNSUBSCRIBE_SECRET'
  | 'EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS'
>;

function ownSecret(env: KeyEnv): string | null {
  const own = env.EMAIL_UNSUBSCRIBE_SECRET;
  return own === undefined || own === '' ? null : own;
}

/** The secrets a token may be checked against, current first, and the one new tokens are signed with. */
function keyMaterial(env: KeyEnv): { signing: string; verifying: string[] } {
  const own = ownSecret(env);
  return own === null
    ? { signing: env.AUTH_SECRET, verifying: [env.AUTH_SECRET, ...previousAuthSecrets(env)] }
    : { signing: own, verifying: [own, ...previousUnsubscribeSecrets(env)] };
}

export function unsubscribeSigningSecret(env: KeyEnv): Buffer {
  return deriveUnsubscribeSecret(keyMaterial(env).signing);
}

export function unsubscribeVerifySecrets(env: KeyEnv): Buffer[] {
  return keyMaterial(env).verifying.map(deriveUnsubscribeSecret);
}

export function replySigningSecret(env: KeyEnv): Buffer {
  return deriveReplySecret(keyMaterial(env).signing);
}

export function replyVerifySecrets(env: KeyEnv): Buffer[] {
  return keyMaterial(env).verifying.map(deriveReplySecret);
}
