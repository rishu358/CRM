import {
  EMAIL_BOUNCE_REASONS,
  EMAIL_FAILURE_CODES,
  EMAIL_STATUSES,
  EMAIL_SUPPRESSION_REASONS,
} from '@crm/core';
import { describe, expect, it } from 'vitest';
import { FAILURE_TEXT, failureKey, splitQuoted } from './emails';
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

describe('folding the history quoted in a reply (ADR-0077)', () => {
  it('separates the new words from the quoted history, and keeps every character of both', () => {
    const body =
      'Thanks, that works.\n\nOn Mon, 9 Nov 2026 at 10:00, Priya <p@x.example> wrote:\n> Here is the quote\n> Regards';
    const { fresh, quoted } = splitQuoted(body);
    expect(fresh).toBe('Thanks, that works.');
    expect(quoted).toBe(
      'On Mon, 9 Nov 2026 at 10:00, Priya <p@x.example> wrote:\n> Here is the quote\n> Regards',
    );
    expect(`${fresh}\n\n${quoted}`).toBe(body);
  });

  it('recognises a bare quote marker and an "original message" line as the start of the history', () => {
    expect(splitQuoted('Yes please.\n> earlier words')).toEqual({
      fresh: 'Yes please.',
      quoted: '> earlier words',
    });
    expect(splitQuoted('Yes.\n-----Original Message-----\nFrom: Priya').quoted).toBe(
      '-----Original Message-----\nFrom: Priya',
    );
    expect(splitQuoted('Yes.\n---- Forwarded message ----\nbody').quoted).toContain(
      'Forwarded message',
    );
  });

  it('does not split a message with no history, or one that starts with the quote', () => {
    for (const body of ['Just one line', 'Two\nlines', '> only a quote\n> and more', '']) {
      expect(splitQuoted(body), body).toEqual({ fresh: body, quoted: null });
    }
  });

  it('is not fooled by a line that only mentions the words', () => {
    const body = 'Please tell me on Monday who wrote:\nthe report';
    expect(splitQuoted(body)).toEqual({ fresh: body, quoted: null });
  });
});
