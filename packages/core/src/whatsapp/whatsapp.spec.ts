import { describe, expect, it } from 'vitest';
import {
  WHATSAPP_MAX_TEXT_LENGTH,
  buildWhatsAppLink,
  isWhatsAppLinkBase,
  isWhatsAppNumber,
  whatsAppTarget,
} from './index.js';

/** A made-up host: the builder knows no real one, it is given the configured base. */
const BASE = 'https://chat.example';

describe('the base', () => {
  it.each([
    'https://chat.example',
    'https://chat.example/',
    'https://chat.example:8443',
    'https://localhost:9000',
  ])('accepts %s', (base) => {
    expect(isWhatsAppLinkBase(base)).toBe(true);
  });

  it.each([
    'http://chat.example',
    'ftp://chat.example',
    'javascript:alert(1)',
    'data:text/html,x',
    '//chat.example',
    'chat.example',
    'https://user@chat.example',
    'https://user:pw@chat.example',
    'https://chat.example/path',
    'https://chat.example/?a=1',
    'https://chat.example?a=1',
    'https://chat.example#x',
    'https://chat.example/\evil.example',
    ' https://chat.example',
    'https://chat.example ',
    'HTTPS://CHAT.EXAMPLE',
    '',
    'not a url',
    null,
    undefined,
    42,
  ])('refuses %s', (base) => {
    expect(isWhatsAppLinkBase(base)).toBe(false);
    expect(buildWhatsAppLink(base, '+919876543210')).toBeNull();
    expect(buildWhatsAppLink(base, '+919876543210', 'hi')).toBeNull();
  });

  it('builds on whichever valid base it is given, with or without a trailing slash', () => {
    expect(buildWhatsAppLink('https://other.example/', '+919876543210')).toBe(
      'https://other.example/919876543210',
    );
    expect(buildWhatsAppLink('https://other.example:8443', '+919876543210', 'hi')).toBe(
      'https://other.example:8443/919876543210?text=hi',
    );
  });

  it('gives no target at all when the base is unusable, rather than blaming the number', () => {
    expect(whatsAppTarget('http://chat.example', { phone: '+919876543210' })).toBeNull();
    expect(whatsAppTarget(undefined, { phone: '+919876543210' })).toBeNull();
  });
});

describe('buildWhatsAppLink: the number', () => {
  it('builds the link from the digits of a valid number', () => {
    expect(buildWhatsAppLink(BASE, '+919876543210')).toBe('https://chat.example/919876543210');
    expect(buildWhatsAppLink(BASE, '+14155552671')).toBe('https://chat.example/14155552671');
  });

  it('accepts the shortest and longest allowed lengths (8 and 15 digits)', () => {
    expect(buildWhatsAppLink(BASE, '+12345678')).toBe('https://chat.example/12345678');
    expect(buildWhatsAppLink(BASE, '+123456789012345')).toBe(
      'https://chat.example/123456789012345',
    );
  });

  it.each([
    ['too short (7 digits)', '+1234567'],
    ['too long (16 digits)', '+1234567890123456'],
    ['no plus', '919876543210'],
    ['leading zero after the plus', '+0919876543210'],
    ['double plus', '++919876543210'],
    ['plus in the middle', '91+9876543210'],
    ['spaces inside', '+91 98765 43210'],
    ['dashes', '+91-9876-543210'],
    ['brackets', '+1 (415) 555-2671'],
    ['leading space', ' +919876543210'],
    ['trailing space', '+919876543210 '],
    ['trailing newline', '+919876543210\n'],
    ['leading newline', '\n+919876543210'],
    ['tab', '+91\t9876543210'],
    ['empty', ''],
    ['only a plus', '+'],
    ['letters', '+91abcdefghij'],
    ['a vanity number', '+1800FLOWERS'],
    ['Arabic-Indic digits', '+٩١٩٨٧٦٥٤٣٢١٠'],
    ['fullwidth digits', '+９１９８７６５４３２１０'],
    ['fullwidth plus', '＋919876543210'],
    ['zero-width space inside', '+9198765\u200B43210'],
    ['zero-width joiner at the end', '+919876543210\u200D'],
    ['right-to-left override', '\u202E+919876543210'],
    ['byte-order mark', '\uFEFF+919876543210'],
    ['null byte', '+919876543210\u0000'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a javascript: URL with a number', 'javascript:alert(+919876543210)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['another host', 'https://evil.example/+919876543210'],
    ['the host with a number', 'chat.example/919876543210'],
    ['a path-escaping attempt', '+919876543210/../../evil'],
    ['a query-smuggling attempt', '+919876543210?text=x&evil=1'],
    ['a fragment', '+919876543210#x'],
    ['a credentials trick', '+919876543210@evil.example'],
    ['a percent-encoded plus', '%2B919876543210'],
    ['an HTML injection', '+919876543210"><script>alert(1)</script>'],
  ])('rejects %s', (_label, value) => {
    expect(buildWhatsAppLink(BASE, value)).toBeNull();
    expect(isWhatsAppNumber(value)).toBe(false);
  });

  it.each([null, undefined, 919876543210, {}, [], ['+919876543210'], true])(
    'rejects a value that is not a string (%s)',
    (value) => {
      expect(buildWhatsAppLink(BASE, value)).toBeNull();
    },
  );

  it('rejects an object whose toString looks like a number', () => {
    expect(buildWhatsAppLink(BASE, { toString: () => '+919876543210' })).toBeNull();
  });
});

describe('buildWhatsAppLink: the message', () => {
  const number = '+919876543210';
  const base = 'https://chat.example/919876543210';

  it('adds no query when there is no text, or only blanks', () => {
    for (const text of [undefined, null, '', '   ', '\n\t ', '\u200B\u200D\uFEFF', 42, {}]) {
      expect(buildWhatsAppLink(BASE, number, text)).toBe(base);
    }
  });

  it('percent-encodes the text', () => {
    expect(buildWhatsAppLink(BASE, number, 'Hi Asha, are you free at 5?')).toBe(
      `${base}?text=Hi%20Asha%2C%20are%20you%20free%20at%205%3F`,
    );
  });

  it('encodes characters that would end the query or start another', () => {
    expect(buildWhatsAppLink(BASE, number, 'a&b=c#d?e/f\\g%h+i')).toBe(
      `${base}?text=a%26b%3Dc%23d%3Fe%2Ff%5Cg%25h%2Bi`,
    );
  });

  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(buildWhatsAppLink(BASE, number, "!'()*")).toBe(`${base}?text=%21%27%28%29%2A`);
  });

  it('does not double-encode text that already looks percent-encoded', () => {
    expect(buildWhatsAppLink(BASE, number, '100%25 sure')).toBe(`${base}?text=100%2525%20sure`);
    expect(buildWhatsAppLink(BASE, number, '%')).toBe(`${base}?text=%25`);
  });

  it('keeps newlines, as %0A, and turns carriage returns into line feeds', () => {
    expect(buildWhatsAppLink(BASE, number, 'one\r\ntwo\rthree\nfour')).toBe(
      `${base}?text=one%0Atwo%0Athree%0Afour`,
    );
  });

  it('encodes emoji and Indian-language text as UTF-8', () => {
    expect(buildWhatsAppLink(BASE, number, '👋')).toBe(`${base}?text=%F0%9F%91%8B`);
    expect(buildWhatsAppLink(BASE, number, 'नमस्ते')).toBe(
      `${base}?text=%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87`,
    );
  });

  it('removes zero-width, bidirectional and control characters from the text', () => {
    expect(
      buildWhatsAppLink(BASE, number, 'a\u200Bb\u200Dc\u202Ed\u2066e\uFEFFf\u0000g\u0007h'),
    ).toBe(`${base}?text=abcdefgh`);
  });

  it('keeps right-to-left letters, which need no invisible marks', () => {
    expect(buildWhatsAppLink(BASE, number, 'مرحبا')).toBe(
      `${base}?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7`,
    );
  });

  it('does not throw on half of a surrogate pair, and does not leak it', () => {
    expect(buildWhatsAppLink(BASE, number, 'a\uD83Db')).toBe(`${base}?text=a%EF%BF%BDb`);
    expect(buildWhatsAppLink(BASE, number, '\uDC00')).toBe(`${base}?text=%EF%BF%BD`);
  });

  it('caps the text at the limit without cutting an emoji in half', () => {
    const long = buildWhatsAppLink(BASE, number, 'x'.repeat(WHATSAPP_MAX_TEXT_LENGTH * 10)) ?? '';
    expect(long).toBe(`${base}?text=${'x'.repeat(WHATSAPP_MAX_TEXT_LENGTH)}`);

    const emoji = buildWhatsAppLink(BASE, number, '👋'.repeat(WHATSAPP_MAX_TEXT_LENGTH + 5)) ?? '';
    const query = emoji.split('?text=')[1] ?? '';
    expect(decodeURIComponent(query)).toBe('👋'.repeat(WHATSAPP_MAX_TEXT_LENGTH));
  });

  it('keeps the whole link bounded even when every character needs encoding', () => {
    const link = buildWhatsAppLink(BASE, number, '👋'.repeat(100_000)) ?? '';
    expect(link.length).toBeLessThan(WHATSAPP_MAX_TEXT_LENGTH * 12 + 100);
  });

  it.each([
    'javascript:alert(1)',
    '"><script>alert(1)</script>',
    "' onmouseover='alert(1)",
    'https://evil.example/',
    '\u0000\u0001javascript:alert(1)',
    '</a><a href="javascript:alert(1)">x',
  ])('puts attack text only inside the encoded query: %s', (attack) => {
    const link = buildWhatsAppLink(BASE, number, attack) ?? '';
    expect(link.startsWith(`${base}?text=`)).toBe(true);
    const url = new URL(link);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('chat.example');
    expect(url.pathname).toBe('/919876543210');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['text']);
    // Nothing that could close an attribute or open a tag survives unencoded.
    expect(link).not.toMatch(/["'<>\s]/);
  });

  it('always yields an https link on the one host, whatever it is given', () => {
    const numbers: unknown[] = ['+919876543210', '+14155552671', 'javascript:1', '', null];
    const texts: unknown[] = [undefined, 'hi', '👋', 'a b', '%00', '\u202Egnp.exe'];
    for (const candidate of numbers) {
      for (const text of texts) {
        const link = buildWhatsAppLink(BASE, candidate, text);
        if (link !== null) {
          expect(link).toMatch(
            /^https:\/\/chat.example\/[1-9][0-9]{7,14}(\?text=[A-Za-z0-9._~%-]+)?$/,
          );
        }
      }
    }
  });
});

describe('whatsAppTarget', () => {
  it('uses the WhatsApp number when there is one', () => {
    expect(whatsAppTarget(BASE, { whatsapp: '+919876543210', phone: '+14155552671' })).toEqual({
      status: 'link',
      source: 'whatsapp',
      number: '+919876543210',
      href: 'https://chat.example/919876543210',
    });
  });

  it('falls back to the phone number when there is no WhatsApp number', () => {
    for (const whatsapp of [undefined, null, '', '   ']) {
      expect(whatsAppTarget(BASE, { whatsapp, phone: '+14155552671' })).toEqual({
        status: 'link',
        source: 'phone',
        number: '+14155552671',
        href: 'https://chat.example/14155552671',
      });
    }
  });

  it('works for a record that has only a phone field (accounts and leads)', () => {
    expect(whatsAppTarget(BASE, { phone: '+919876543210' })?.source).toBe('phone');
  });

  it('is null when there is no usable number at all', () => {
    expect(whatsAppTarget(BASE, {})).toBeNull();
    expect(whatsAppTarget(BASE, { whatsapp: null, phone: null })).toBeNull();
    expect(whatsAppTarget(BASE, { whatsapp: ' ', phone: '' })).toBeNull();
  });

  it('reports a malformed WhatsApp number instead of quietly using the phone', () => {
    expect(whatsAppTarget(BASE, { whatsapp: '98765 43210', phone: '+14155552671' })).toEqual({
      status: 'invalid',
      source: 'whatsapp',
      number: '98765 43210',
    });
  });

  it('reports a malformed phone number when it is the only one', () => {
    expect(whatsAppTarget(BASE, { phone: '+1' })).toEqual({
      status: 'invalid',
      source: 'phone',
      number: '+1',
    });
  });

  it('never returns an href for a number that is not E.164', () => {
    const target = whatsAppTarget(BASE, { phone: 'javascript:alert(1)' });
    expect(target?.status).toBe('invalid');
    expect(target !== null && 'href' in target).toBe(false);
  });
});
