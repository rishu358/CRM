import { describe, expect, it } from 'vitest';
import { buildCsp, originOf, type CspOptions } from './csp';

const NONCE = 'dGhpcyBpcyBhIG5vbmNlIQ==';
const production: CspOptions = {
  nonce: NONCE,
  development: false,
  https: true,
  connectOrigins: [],
};

const directive = (policy: string, name: string): string | undefined =>
  policy
    .split('; ')
    .find((part) => part === name || part.startsWith(`${name} `))
    ?.slice(name.length)
    .trim();

describe('the production policy', () => {
  const policy = buildCsp(production);

  it('lets a script run only with this request’s nonce, and has no unsafe-inline or host allowlist for scripts', () => {
    const scripts = directive(policy, 'script-src')!;
    expect(scripts).toContain(`'nonce-${NONCE}'`);
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toMatch(/https?:/);
    expect(scripts).not.toContain('*');
  });

  it('locks style elements to the app and the nonce, and allows only style attributes inline', () => {
    expect(directive(policy, 'style-src')).toBe(`'self' 'nonce-${NONCE}'`);
    expect(directive(policy, 'style-src-attr')).toBe("'unsafe-inline'");
  });

  it('forbids embedding, framing, objects, a changed base and a form posted elsewhere', () => {
    expect(directive(policy, 'object-src')).toBe("'none'");
    expect(directive(policy, 'frame-ancestors')).toBe("'none'");
    expect(directive(policy, 'base-uri')).toBe("'self'");
    expect(directive(policy, 'form-action')).toBe("'self'");
    expect(directive(policy, 'default-src')).toBe("'self'");
  });

  it('allows connections to this origin only, when no object store is configured', () => {
    expect(directive(policy, 'connect-src')).toBe("'self'");
  });

  it('upgrades insecure requests when the request was secure', () => {
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('never contains a wildcard source', () => {
    expect(policy).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });
});

describe('what varies', () => {
  it('does not upgrade insecure requests on a plain-http deployment, which would break it', () => {
    expect(buildCsp({ ...production, https: false })).not.toContain('upgrade-insecure-requests');
  });

  it('adds the object store to connect-src and nowhere else', () => {
    const policy = buildCsp({ ...production, connectOrigins: ['https://files.example.com'] });
    expect(directive(policy, 'connect-src')).toBe("'self' https://files.example.com");
    expect(policy.split('https://files.example.com')).toHaveLength(2);
  });

  it('lists an origin once however many times it is given', () => {
    const policy = buildCsp({
      ...production,
      connectOrigins: ['https://f.example.com', 'https://f.example.com'],
    });
    expect(policy.split('https://f.example.com')).toHaveLength(2);
  });

  it('opens up only what the dev server needs in development', () => {
    const policy = buildCsp({ ...production, development: true });
    expect(directive(policy, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(policy, 'connect-src')).toContain('ws:');
    expect(directive(policy, 'style-src')).toContain("'unsafe-inline'");
    // And nothing about scripts ever allows an inline one.
    expect(directive(policy, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('refuses a nonce that is too short or could split the header', () => {
    expect(() => buildCsp({ ...production, nonce: 'short' })).toThrow();
    expect(() => buildCsp({ ...production, nonce: `${NONCE}; script-src *` })).toThrow();
    expect(() => buildCsp({ ...production, nonce: `${NONCE}\r\nX: y` })).toThrow();
  });
});

describe('originOf', () => {
  it('reduces a URL to its origin', () => {
    expect(originOf('https://files.example.com/bucket/key?x=1')).toBe('https://files.example.com');
    expect(originOf('http://localhost:19000/')).toBe('http://localhost:19000');
  });

  it('returns nothing for what is not an http(s) URL, so it never reaches a header', () => {
    for (const bad of [
      undefined,
      '',
      '  ',
      'not a url',
      'javascript:alert(1)',
      'file:///x',
      'ftp://x.example',
    ]) {
      expect(originOf(bad)).toBeNull();
    }
  });

  it('cannot smuggle a directive in through the origin', () => {
    expect(originOf('https://a.example.com; script-src *')).toBeNull();
  });
});
