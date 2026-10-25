import { describe, expect, it } from 'vitest';
import { clientAddressHeaders } from './client-address';

const of = (value: string | null) =>
  clientAddressHeaders(new Headers(value === null ? {} : { 'x-forwarded-for': value }));

describe('the client address passed to the API', () => {
  it('passes on the address the front proxy saw', () => {
    expect(of('203.0.113.7')).toEqual({ 'x-forwarded-for': '203.0.113.7' });
    expect(of('2001:db8::7')).toEqual({ 'x-forwarded-for': '2001:db8::7' });
  });

  it('passes on only the first of several, so a chain cannot be smuggled through', () => {
    expect(of('203.0.113.7, 10.0.0.1, 10.0.0.2')).toEqual({ 'x-forwarded-for': '203.0.113.7' });
  });

  it('passes on nothing when there is none: the API then sees this server', () => {
    expect(of(null)).toEqual({});
    expect(of('')).toEqual({});
  });

  it.each([
    'not-an-ip',
    '203.0.113.7:8080',
    '203.0.113.256',
    '203.0.113.7; DROP TABLE users',
    '203.0.113.7\r\nx-injected: 1',
    '<script>alert(1)</script>',
    'unknown',
  ])('refuses something that is not a single address: %s', (value) => {
    // `Headers` itself refuses a value with a line break, so build the case the way a library might.
    const headers = { get: () => value } as unknown as Headers;
    expect(clientAddressHeaders(headers)).toEqual({});
  });
});
