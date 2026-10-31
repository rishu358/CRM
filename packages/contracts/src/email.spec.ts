import { describe, expect, it } from 'vitest';
import { emailSendSchema, emailSettingsUpdateSchema, emailSubjectSchema } from './email.js';

const target = {
  objectType: 'contact',
  recordId: '01a18be6-380c-757d-9711-d6b7e6c289ee',
  body: 'Hello',
} as const;

describe('a subject or a sender name is one line', () => {
  it.each([
    ['a line feed', 'Quote\nBcc: x@evil.example'],
    ['a carriage return', 'Quote\rBcc: x@evil.example'],
    ['a NUL', 'Quote\u0000'],
    ['a tab', 'Quote\tfor April'],
    ['a delete character', 'Quote\u007f'],
  ])('refuses %s in a subject instead of flattening it', (_what, subject) => {
    expect(emailSubjectSchema.safeParse(subject).success).toBe(false);
    expect(emailSendSchema.safeParse({ ...target, subject }).success).toBe(false);
  });

  it('refuses the same in a sender name', () => {
    for (const fromName of ['Acme\nBcc: x@evil.example', 'Acme\r', 'Acme\u0000']) {
      expect(
        emailSettingsUpdateSchema.safeParse({ fromName, replyTo: null, footerText: null }).success,
      ).toBe(false);
    }
  });

  it('accepts an ordinary subject and tidies its spaces', () => {
    expect(emailSubjectSchema.parse('  Quote   for  April  ')).toBe('Quote for April');
  });

  it('refuses a recipient, a sender or a status the client names', () => {
    for (const extra of [{ to: 'a@b.example' }, { from: 'a@b.example' }, { status: 'sent' }]) {
      expect(emailSendSchema.safeParse({ ...target, subject: 'Hi', ...extra }).success).toBe(false);
    }
  });
});
