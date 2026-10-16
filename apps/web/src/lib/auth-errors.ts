import { t, type TranslationKey } from './i18n';
import type { AuthFailure } from './session';

/**
 * Turn an API error code into a message for the screen.
 *
 * Mapping on the **code**, never on the message: codes are part of the API
 * contract and messages are not (CLAUDE.md §8), so matching on text would
 * break the moment someone improves the wording.
 *
 * Anything unrecognised falls back to a generic message rather than showing
 * the server's own. Server messages are written for API consumers and can
 * carry detail that is noise — or worse, a hint — on a sign-in screen.
 */
const BY_CODE: Partial<Record<string, TranslationKey>> = {
  INVALID_CREDENTIALS: 'auth.error.invalidCredentials',
  EMAIL_NOT_VERIFIED: 'auth.error.notVerified',
  MFA_INVALID: 'auth.error.mfaInvalid',
  INVALID_TOKEN: 'auth.verify.failed.description',
  RATE_LIMITED: 'auth.error.throttled',
  VALIDATION_FAILED: 'auth.error.passwordPolicy',
};

export function authErrorMessage(failure: AuthFailure): string {
  const key = BY_CODE[failure.code];
  return key === undefined ? t('auth.error.generic') : t(key);
}
