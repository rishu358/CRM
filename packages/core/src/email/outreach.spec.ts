import { describe, expect, it } from 'vitest';
import {
  addressDomain,
  bareAddress,
  buildMessageId,
  emailLimitsFor,
  hasEmailConsentRecord,
  isEmailConsentWithdrawn,
  isValidBody,
  isValidFromName,
  isValidReplyTo,
  isValidSubject,
  localDay,
  renderEmailHtml,
  renderEmailText,
  secondsUntilLocalMidnight,
  tenantAgeDays,
} from './outreach.js';

describe('From name', () => {
  it('accepts a company name', () => {
    expect(isValidFromName('Sharma Traders')).toBe(true);
    expect(isValidFromName('Sharma & Sons (Pune), Ltd.')).toBe(true);
  });

  it.each([
    'Bank <ceo@bank.example>',
    'Name"quoted',
    'a@b.example',
    'Line\r\nBcc: x@y.example',
    'Tab\there',
    '',
    ' leading',
    'x'.repeat(81),
  ])('refuses %j', (value) => {
    expect(isValidFromName(value)).toBe(false);
  });
});

describe('Reply-To and subject', () => {
  it('takes one plain address', () => {
    expect(isValidReplyTo('sales@shop.example')).toBe(true);
    expect(isValidReplyTo('Sales <sales@shop.example>')).toBe(false);
    expect(isValidReplyTo('a@b.example, c@d.example')).toBe(false);
    expect(isValidReplyTo('a@b.example\r\nBcc: x@y.example')).toBe(false);
  });

  it('refuses a subject with a line break', () => {
    expect(isValidSubject('Quote for April')).toBe(true);
    expect(isValidSubject('Quote\r\nBcc: x@y.example')).toBe(false);
    expect(isValidSubject('')).toBe(false);
    expect(isValidSubject('x'.repeat(201))).toBe(false);
  });

  it('keeps line breaks in a body and refuses an empty or oversized one', () => {
    expect(isValidBody('Hello\n\nThanks')).toBe(true);
    expect(isValidBody('   ')).toBe(false);
    expect(isValidBody('x'.repeat(10_001))).toBe(false);
  });
});

describe('addresses', () => {
  it('reads the domain and the bare address', () => {
    expect(addressDomain('A@Mail.Example.COM')).toBe('mail.example.com');
    expect(addressDomain('nobody')).toBeNull();
    expect(bareAddress('Shop <Mail@Send.Example>')).toBe('mail@send.example');
    expect(bareAddress('mail@send.example')).toBe('mail@send.example');
    expect(buildMessageId('abc', 'send.example')).toBe('<abc@send.example>');
  });
});

describe('rendering', () => {
  it('escapes every character that could start markup', () => {
    const html = renderEmailHtml('Hi <script>alert(1)</script> & "you"\n\nSecond', null);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<p>Second</p>');
  });

  it('turns single breaks into <br> and appends an escaped footer', () => {
    const html = renderEmailHtml('a\nb', 'Shop <Pune>');
    expect(html).toContain('<p>a<br>b</p>');
    expect(html).toContain('Shop &lt;Pune&gt;');
    expect(renderEmailText('a\r\nb', 'Shop')).toBe('a\nb\n\n-- \nShop');
    expect(renderEmailText('a', null)).toBe('a');
  });

  it('puts the unsubscribe sentence under the same separator, after the footer, in text and HTML', () => {
    const unsubscribe = {
      companyName: 'Sharma <Traders>',
      pageUrl: 'https://app.example/u/v1.abc.def',
    };
    expect(renderEmailText('Hi', 'Shop', unsubscribe)).toBe(
      'Hi\n\n-- \nShop\n\nTo stop receiving email from Sharma <Traders>, open: https://app.example/u/v1.abc.def',
    );
    expect(renderEmailText('Hi', null, unsubscribe)).toBe(
      'Hi\n\n-- \nTo stop receiving email from Sharma <Traders>, open: https://app.example/u/v1.abc.def',
    );
    const html = renderEmailHtml('Hi', 'Shop', unsubscribe);
    expect(html).toContain('Sharma &lt;Traders&gt;');
    expect(html).not.toContain('<Traders>');
    expect(html).toContain('<a href="https://app.example/u/v1.abc.def">unsubscribe</a>');
    expect(html.indexOf('Shop')).toBeLessThan(html.indexOf('unsubscribe'));
  });

  it('escapes a link that tries to leave its attribute, so only the address we built is ever a link', () => {
    const html = renderEmailHtml('Hi', null, {
      companyName: 'Shop',
      pageUrl: 'https://app.example/u/x"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('"><');
    expect(html).toContain('u/x&quot;&gt;&lt;script&gt;');
  });

  it('adds nothing when there is no link, so older callers and system mail are unchanged', () => {
    expect(renderEmailText('a', 'Shop', null)).toBe(renderEmailText('a', 'Shop'));
    expect(renderEmailHtml('a', 'Shop', null)).toBe(renderEmailHtml('a', 'Shop'));
  });
});

describe('limits and days', () => {
  it('uses the lower figures for a young workspace', () => {
    expect(emailLimitsFor(3)).toEqual({ perUser: 20, perTenant: 100 });
    expect(emailLimitsFor(14)).toEqual({ perUser: 100, perTenant: 500 });
    expect(tenantAgeDays(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-16T12:00:00Z'))).toBe(
      15,
    );
  });

  it('counts the day in the workspace time zone', () => {
    // 20:00 UTC on 1 Nov is 01:30 on 2 Nov in India.
    const now = new Date('2026-11-01T20:00:00Z');
    expect(localDay(now, 'Asia/Kolkata')).toBe('2026-11-02');
    expect(localDay(now, 'UTC')).toBe('2026-11-01');
    expect(secondsUntilLocalMidnight(now, 'Asia/Kolkata')).toBe(86_400 - (1 * 3600 + 30 * 60));
  });
});

describe('consent', () => {
  it('blocks only an explicit withdrawal', () => {
    expect(isEmailConsentWithdrawn({ email: { status: 'withdrawn' } })).toBe(true);
    expect(isEmailConsentWithdrawn({ email: { status: 'granted' } })).toBe(false);
    expect(isEmailConsentWithdrawn({})).toBe(false);
    expect(isEmailConsentWithdrawn(null)).toBe(false);
    expect(hasEmailConsentRecord({ email: { status: 'granted' } })).toBe(true);
    expect(hasEmailConsentRecord({})).toBe(false);
  });
});
