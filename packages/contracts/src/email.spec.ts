import { describe, expect, it } from 'vitest';
import {
  emailSendSchema,
  emailSettingsUpdateSchema,
  emailSignatureUpdateSchema,
  emailSubjectSchema,
  emailTemplateCreateSchema,
  emailTemplateUpdateSchema,
} from './email.js';

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

describe('merge fields in what is sent or saved', () => {
  it('accepts the fields on the list, with or without spaces inside the braces', () => {
    expect(
      emailSendSchema.safeParse({
        ...target,
        subject: 'Hi {{contact.first_name}}',
        body: 'Dear {{ contact.last_name }} from {{sender.name}} at {{company.name}}',
      }).success,
    ).toBe(true);
  });

  it.each(['{{contact.email}}', '{{ Contact Name }}', '{{}}', '{{contact.phone}}'])(
    'refuses %s in a subject, a message and a template',
    (field) => {
      expect(
        emailSendSchema.safeParse({ ...target, subject: `Hi ${field}`, body: 'x' }).success,
      ).toBe(false);
      expect(
        emailSendSchema.safeParse({ ...target, subject: 'Hi', body: `Hello ${field}` }).success,
      ).toBe(false);
      expect(
        emailTemplateCreateSchema.safeParse({ name: 'T', subject: 'Hi', body: `Hello ${field}` })
          .success,
      ).toBe(false);
    },
  );

  it('needs a template change to change something, and a version', () => {
    expect(emailTemplateUpdateSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(emailTemplateUpdateSchema.safeParse({ name: 'New', version: 1 }).success).toBe(true);
    expect(emailTemplateUpdateSchema.safeParse({ name: 'New' }).success).toBe(false);
  });

  it('refuses a template or signature that names an owner or an id of its own', () => {
    expect(
      emailTemplateCreateSchema.safeParse({ name: 'T', subject: 's', body: 'b', createdBy: 'x' })
        .success,
    ).toBe(false);
    expect(emailSignatureUpdateSchema.safeParse({ text: 'Priya', userId: 'x' }).success).toBe(
      false,
    );
    expect(emailSignatureUpdateSchema.safeParse({ text: 'x'.repeat(501) }).success).toBe(false);
    expect(emailSignatureUpdateSchema.safeParse({ text: '' }).success).toBe(true);
  });
});
