import { deriveUnsubscribeSecret } from '@crm/core/email-unsubscribe-token';
import { previousAuthSecrets, previousUnsubscribeSecrets, type ApiEnv } from '../config/env.js';

/**
 * The keys the unsubscribe token (ADR-0076) is signed and checked with.
 *
 * **With `EMAIL_UNSUBSCRIBE_SECRET` set** (production requires it) the key is derived from that and only that:
 * a link in an email sent last year must still work after the session secret is rotated, so the link has a
 * secret of its own that is not rotated on a schedule. New tokens are signed with it; a token is checked against
 * it and every key in `EMAIL_UNSUBSCRIBE_SECRET_PREVIOUS`, so an old key can be kept for as long as its links
 * matter. A token signed under any other key, `AUTH_SECRET` included, is refused.
 *
 * **With it unset** (development, tests, CI: production refuses to start) the key falls back to one derived
 * from `AUTH_SECRET`, so a local stack needs no extra setting. That fallback is what must never run in a real
 * deployment, and the production guard is what stops it.
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

export function unsubscribeSigningSecret(env: KeyEnv): Buffer {
  return deriveUnsubscribeSecret(ownSecret(env) ?? env.AUTH_SECRET);
}

export function unsubscribeVerifySecrets(env: KeyEnv): Buffer[] {
  const own = ownSecret(env);
  const keys =
    own === null
      ? [env.AUTH_SECRET, ...previousAuthSecrets(env)]
      : [own, ...previousUnsubscribeSecrets(env)];
  return keys.map(deriveUnsubscribeSecret);
}
