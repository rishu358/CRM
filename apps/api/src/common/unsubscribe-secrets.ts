import { deriveUnsubscribeSecret } from '@crm/core/email-unsubscribe-token';
import { previousAuthSecrets, type ApiEnv } from '../config/env.js';

/**
 * The keys the unsubscribe token (ADR-0076) is signed and checked with, derived from the instance's auth
 * secret so the feature adds none of its own.
 *
 * New tokens are signed with the current key only. A token is checked against the current key **and** every key
 * in `AUTH_SECRET_PREVIOUS`, because a link in an email sent last year must still work after the secret was
 * rotated (docs/SECRETS.md says what that means for removing an old key).
 */
export function unsubscribeSigningSecret(env: Pick<ApiEnv, 'AUTH_SECRET'>): Buffer {
  return deriveUnsubscribeSecret(env.AUTH_SECRET);
}

export function unsubscribeVerifySecrets(
  env: Pick<ApiEnv, 'AUTH_SECRET' | 'AUTH_SECRET_PREVIOUS'>,
): Buffer[] {
  return [env.AUTH_SECRET, ...previousAuthSecrets(env)].map(deriveUnsubscribeSecret);
}
