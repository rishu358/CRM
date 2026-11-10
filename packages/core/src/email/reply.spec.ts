import { describe, expect, it } from 'vitest';
import { EMAIL_BODY_MAX } from './outreach.js';
import {
  EMAIL_REPLY_LIMITS,
  NO_PLAIN_TEXT,
  emailIdFromReplyLocal,
  isReplyAddressShape,
  normalizeInboundDomain,
  parseReplyAddress,
  replyAddress,
  shapeReceivedEmail,
  type ReceivedEmail,
} from './reply.js';

const ID = '0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d';
const HEX = ID.replaceAll('-', '');
const SIGNATURE = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 26);
const LOCAL = `r.${HEX}.${SIGNATURE}`;
const DOMAIN = 'reply.example.com';

describe('the reply address', () => {
  it('has a local part of 61 characters, inside the 64 a mail address allows', () => {
    expect(LOCAL).toHaveLength(61);
    expect(replyAddress(LOCAL, DOMAIN)).toBe(`${LOCAL}@${DOMAIN}`);
    expect(isReplyAddressShape(`${LOCAL}@${DOMAIN}`)).toBe(true);
  });

  it('finds the email id inside it, and nothing else', () => {
    expect(emailIdFromReplyLocal(LOCAL)).toBe(ID);
    expect(parseReplyAddress(`${LOCAL}@${DOMAIN}`, DOMAIN)).toEqual({ token: LOCAL, emailId: ID });
  });

  it('survives a mail system changing its case, because it is lower-case and is folded first', () => {
    expect(parseReplyAddress(`${LOCAL.toUpperCase()}@${DOMAIN.toUpperCase()}`, DOMAIN)).toEqual({
      token: LOCAL,
      emailId: ID,
    });
    expect(parseReplyAddress(`  ${LOCAL}@${DOMAIN} `, DOMAIN)?.emailId).toBe(ID);
  });

  it.each([
    ['another domain', `${LOCAL}@other.example.com`],
    ['a subdomain of ours', `${LOCAL}@mail.${DOMAIN}`],
    ['no @', LOCAL],
    ['an empty local part', `@${DOMAIN}`],
    ['a short signature', `r.${HEX}.${SIGNATURE.slice(0, 25)}@${DOMAIN}`],
    ['a long signature', `r.${HEX}.${SIGNATURE}a@${DOMAIN}`],
    ['a short id', `r.${HEX.slice(0, 31)}.${SIGNATURE}@${DOMAIN}`],
    ['a character outside base32', `r.${HEX}.${SIGNATURE.slice(0, 25)}1@${DOMAIN}`],
    ['another prefix', `x.${HEX}.${SIGNATURE}@${DOMAIN}`],
    ['plus addressing', `${LOCAL}+tag@${DOMAIN}`],
    ['a display name', `Someone <${LOCAL}@${DOMAIN}>`],
  ])('does not recognise %s', (_what, address) => {
    expect(parseReplyAddress(address, DOMAIN)).toBeNull();
  });

  it('refuses a value that is not a string at all', () => {
    for (const value of [undefined, null, 7, {}, ['a']])
      expect(isReplyAddressShape(value)).toBe(false);
  });
});

describe('the inbound domain', () => {
  it('is a plain lower-case host name with at least one dot', () => {
    expect(normalizeInboundDomain('Reply.Example.COM')).toBe('reply.example.com');
    expect(normalizeInboundDomain(' reply.example.com ')).toBe('reply.example.com');
    expect(normalizeInboundDomain('a-b.example.co.uk')).toBe('a-b.example.co.uk');
  });

  it.each([
    undefined,
    '',
    '   ',
    'localhost',
    'reply',
    'reply..example.com',
    '-reply.example.com',
    'reply-.example.com',
    'reply example.com',
    'reply.example.com/path',
    'user@reply.example.com',
    'https://reply.example.com',
    'reply.example.com:25',
    `${'a'.repeat(64)}.example.com`,
    `${'a.'.repeat(130)}com`,
  ])('refuses %j, so a typo cannot quietly print addresses that go nowhere', (value) => {
    expect(normalizeInboundDomain(value)).toBeNull();
  });
});

const received = (change: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  fromAddress: 'Sam@Customer.Example',
  fromName: 'Sam Customer',
  subject: 'Re: Your quote',
  text: 'Thanks, that works for us.',
  messageId: '<abc@customer.example>',
  attachmentCount: 0,
  ...change,
});

describe('shaping a received message for the log', () => {
  it('lower-cases the sender and keeps the words', () => {
    expect(shapeReceivedEmail(received())).toEqual({
      fromName: 'Sam Customer',
      fromAddress: 'sam@customer.example',
      subject: 'Re: Your quote',
      body: 'Thanks, that works for us.',
      bodyShortened: false,
    });
  });

  it.each([
    'not an address',
    'a@b@c.example',
    'sam@',
    '@customer.example',
    'sam@customer.example, other@customer.example',
    '<sam@customer.example>',
    'sam@customer.example\r\nBcc: x@evil.example',
    `${'a'.repeat(65)}@customer.example`,
  ])('has no usable sender in %j', (fromAddress) => {
    expect(shapeReceivedEmail(received({ fromAddress }))).toBeNull();
  });

  it('uses the address when there is no name, and cuts a long name to 80 characters on one line', () => {
    expect(shapeReceivedEmail(received({ fromName: null }))?.fromName).toBe('sam@customer.example');
    expect(shapeReceivedEmail(received({ fromName: '   ' }))?.fromName).toBe(
      'sam@customer.example',
    );
    const long = shapeReceivedEmail(received({ fromName: `A\nB ${'x'.repeat(200)}` }))!;
    expect(long.fromName).toHaveLength(80);
    expect(long.fromName).not.toContain('\n');
  });

  it('cuts the subject to 200 characters on one line, and says when there is none', () => {
    const subject = shapeReceivedEmail(
      received({ subject: `Re:\r\nSecond line ${'y'.repeat(300)}` }),
    )!;
    expect(subject.subject).toHaveLength(200);
    expect(subject.subject).not.toMatch(/[\r\n]/);
    expect(shapeReceivedEmail(received({ subject: '' }))?.subject).toBe('(no subject)');
    expect(shapeReceivedEmail(received({ subject: ' \n ' }))?.subject).toBe('(no subject)');
  });

  it('says so when there is no plain-text part, and stores nothing in its place', () => {
    for (const text of [null, '', '   \n  ']) {
      expect(shapeReceivedEmail(received({ text }))).toMatchObject({
        body: NO_PLAIN_TEXT,
        bodyShortened: false,
      });
    }
  });

  it('normalises line endings and drops control characters, keeping line breaks and tabs', () => {
    const dirty = [
      'a\r\nb\rc\td',
      String.fromCharCode(0),
      'e',
      String.fromCharCode(7),
      'f',
      String.fromCharCode(27),
      '[31mg',
    ].join('');
    const shaped = shapeReceivedEmail(received({ text: dirty }))!;
    expect(shaped.body).toBe('a\nb\nc\tdef[31mg');
    for (const character of shaped.body) {
      const code = character.charCodeAt(0);
      expect(code >= 32 || code === 10 || code === 9).toBe(true);
    }
  });

  it('cuts the body to the same limit an outgoing one has, and says it did', () => {
    const exact = shapeReceivedEmail(received({ text: 'x'.repeat(EMAIL_BODY_MAX) }))!;
    expect(exact.body).toHaveLength(EMAIL_BODY_MAX);
    expect(exact.bodyShortened).toBe(false);
    const over = shapeReceivedEmail(received({ text: 'x'.repeat(EMAIL_BODY_MAX + 1) }))!;
    expect(over.body).toHaveLength(EMAIL_BODY_MAX);
    expect(over.bodyShortened).toBe(true);
  });

  it('never returns markup as anything but text: an HTML-looking body is kept as the characters it is', () => {
    const shaped = shapeReceivedEmail(received({ text: '<script>alert(1)</script> <b>hi</b>' }))!;
    expect(shaped.body).toBe('<script>alert(1)</script> <b>hi</b>');
  });
});

describe('the limits', () => {
  it('are small numbers, in one place', () => {
    expect(EMAIL_REPLY_LIMITS).toEqual({
      perEmail: 20,
      perCompanyPerDay: 500,
      fetchMaxBytes: 1_048_576,
    });
  });
});
