import {
  EMAIL_BOUNCE_REASONS,
  EMAIL_FAILURE_CODES,
  EMAIL_STATUSES,
  EMAIL_SUPPRESSION_REASONS,
} from '@crm/core';
import { describe, expect, it } from 'vitest';
import { FAILURE_TEXT, failureKey } from './emails';
import { en, t, type TranslationKey } from './i18n';

/**
 * The words the email screens use (ADR-0073): every failure the API can report and every status it can
 * hold has a plain sentence, so a code never reaches a person, and a status added on the server cannot
 * quietly show up as a raw word.
 */
describe('email wording', () => {
  it('explains every failure code the API can report', () => {
    for (const code of EMAIL_FAILURE_CODES) {
      const key = FAILURE_TEXT[code];
      expect(key, code).toBeDefined();
      expect(t(key as TranslationKey).length, code).toBeGreaterThan(10);
    }
  });

  it('falls back to a sentence for a code it does not know, never to the code itself', () => {
    expect(t(failureKey('some_future_code'))).not.toContain('some_future_code');
    expect(t(failureKey(null))).toBe(t('email.failure.rejected'));
  });

  it('names every status', () => {
    for (const status of EMAIL_STATUSES) {
      expect(en[`email.status.${status}` as TranslationKey], status).toBeDefined();
    }
  });

  it('says that "sent" is not "delivered"', () => {
    expect(t('email.status.sent.hint')).toMatch(/may not have reached/i);
  });

  it('explains every reason an email can bounce and every reason an address can be blocked', () => {
    for (const reason of EMAIL_BOUNCE_REASONS) {
      expect(en[`email.bounce.is_${reason}` as TranslationKey], reason).toBeDefined();
    }
    for (const reason of EMAIL_SUPPRESSION_REASONS) {
      expect(en[`email.suppressed.${reason}` as TranslationKey], reason).toBeDefined();
      expect(en[`email.suppressions.reason.${reason}` as TranslationKey], reason).toBeDefined();
    }
  });
});
