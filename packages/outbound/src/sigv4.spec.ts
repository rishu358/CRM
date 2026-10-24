import { describe, expect, it } from 'vitest';
import { amzDate, signV4 } from './sigv4.js';

/**
 * Signature Version 4 against the vector AWS publishes in its own documentation ("get-vanilla"):
 * a made-up credential, a fixed instant, and a signature nobody can produce by accident. If this
 * passes, the canonicalisation, the key derivation and the scope are right; the email adapter's
 * tests then only have to prove it signs what it sends.
 */
const VECTOR = {
  method: 'GET',
  host: 'example.amazonaws.com',
  path: '/',
  region: 'us-east-1',
  service: 'service',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  headers: {},
  body: '',
  now: new Date('2015-08-30T12:36:00Z'),
} as const;

describe('signV4', () => {
  it('produces the signature AWS publishes for its get-vanilla test vector', () => {
    expect(signV4(VECTOR).headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('sends the date it signed, and leaves host to the client', () => {
    const { headers } = signV4(VECTOR);
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers).not.toHaveProperty('host');
  });

  it('signs the body and the extra headers: changing either changes the signature', () => {
    const sig = (overrides: object) => signV4({ ...VECTOR, ...overrides }).headers['authorization'];
    const plain = sig({});
    expect(sig({ body: '{}' })).not.toBe(plain);
    expect(sig({ headers: { 'content-type': 'application/json' } })).not.toBe(plain);
    expect(sig({ secretAccessKey: 'another' })).not.toBe(plain);
    expect(sig({ region: 'ap-south-1' })).not.toBe(plain);
  });

  it('lists signed headers sorted and lowercase, whatever case they were given', () => {
    const { headers } = signV4({
      ...VECTOR,
      headers: { 'Content-Type': ' application/json ', Accept: 'x' },
    });
    expect(headers['authorization']).toContain('SignedHeaders=accept;content-type;host;x-amz-date');
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('amzDate', () => {
  it('is the compact UTC form, without milliseconds', () => {
    expect(amzDate(new Date('2026-10-24T18:05:09.123Z'))).toBe('20261024T180509Z');
  });
});
