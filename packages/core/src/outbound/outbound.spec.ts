import { describe, expect, it } from 'vitest';
import {
  checkOutboundUrl,
  classifyAddress,
  parseIpv4,
  parseIpv6,
  type OutboundUrlPolicy,
} from './index.js';

/**
 * §5.13: which addresses and URLs a server may be pointed at.
 *
 * These are tables because the failure this guards against is never the case somebody
 * thought of. Each row is a way a private destination has been written, or a public one
 * must still be reachable; a row that stops being true is the regression.
 */

const refused = (address: string) => {
  const decision = classifyAddress(address);
  return decision.allowed ? 'allowed' : decision.reason;
};

describe('IPv4 addresses', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['0.255.255.255', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'carrier_grade_nat'],
    ['100.127.255.255', 'carrier_grade_nat'],
    ['100.100.100.200', 'metadata'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.0.1', 'link_local'],
    ['169.254.169.254', 'metadata'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['192.168.0.1', 'private'],
    ['192.168.255.255', 'private'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
  ])('refuses %s as %s', (address, reason) => {
    expect(refused(address)).toBe(reason);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '169.255.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.1',
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '52.95.110.1',
  ])('allows the public address %s, one step either side of each blocked range', (address) => {
    expect(refused(address)).toBe('allowed');
  });

  it.each([
    ['010.0.0.1', 'leading zero: octal to some parsers, decimal to others'],
    ['0x7f.0.0.1', 'hex'],
    ['127.1', 'short form'],
    ['2130706433', 'one big decimal'],
    ['1.2.3', 'three parts'],
    ['1.2.3.4.5', 'five parts'],
    ['256.1.1.1', 'octet out of range'],
    ['1.2.3.-4', 'negative'],
    ['1.2.3.4 ', 'trailing space'],
    [' 1.2.3.4', 'leading space'],
    ['1.2.3.4/32', 'with a prefix'],
    ['', 'empty'],
    ['localhost', 'a name'],
  ])('refuses %j as not an address (%s)', (text) => {
    expect(refused(text)).toBe('not_an_address');
  });

  it('parses a dotted quad strictly', () => {
    expect(parseIpv4('1.2.3.4')).toBe(0x01020304);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
    expect(parseIpv4('01.2.3.4')).toBeNull();
    expect(parseIpv4('1.2.3.04')).toBeNull();
    expect(parseIpv4('0.0.0.0')).toBe(0);
  });
});

describe('IPv6 addresses', () => {
  it.each([
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['[::1]', 'loopback'],
    ['fe80::1', 'link_local'],
    ['febf:ffff::1', 'link_local'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456:789a::1', 'unique_local'],
    ['fd00:ec2::254', 'metadata'],
    ['ff02::1', 'multicast'],
    ['ff00::', 'multicast'],
    ['64:ff9b::7f00:1', 'translation'],
    ['64:ff9b::8.8.8.8', 'translation'],
    ['64:ff9b:1::1', 'translation'],
    ['2002:7f00:1::', 'translation'],
    ['2002:c0a8:1::1', 'translation'],
    ['2001::1', 'reserved'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['100::1', 'reserved'],
    ['1::1', 'reserved'],
    ['4000::1', 'reserved'],
    ['fec0::1', 'reserved'],
  ])('refuses %s as %s', (address, reason) => {
    expect(refused(address)).toBe(reason);
  });

  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['[::ffff:7f00:1]', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['0:0:0:0:0:ffff:192.168.1.1', 'private'],
    // A public IPv4 address wearing an IPv6 mapping is refused too: nothing resolves to one,
    // and an address that only exists to dodge a check has no honest use.
    ['::ffff:8.8.8.8', 'translation'],
  ])('looks inside the IPv4 mapping of %s', (address, reason) => {
    expect(refused(address)).toBe(reason);
  });

  it.each([
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
    '2001:4860:4860::8888',
    '2620:fe::fe',
  ])('allows the global unicast address %s', (address) => {
    expect(refused(address)).toBe('allowed');
  });

  it.each([
    'fe80::1%eth0',
    ':::',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    'g::1',
    '12345::1',
    '::1.2.3',
    '::1.2.3.256',
    '1:2:3:4:5:6:7::8',
    '[::1',
    '::1]',
  ])('refuses %j as not an address', (text) => {
    expect(refused(text)).toBe('not_an_address');
  });

  it('parses compression, a dotted tail and the full form', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('1::8')).toEqual([1, 0, 0, 0, 0, 0, 0, 8]);
    expect(parseIpv6('1:2:3:4:5:6:7::')).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });
});

describe('what the URL parser turns hostile spellings into', () => {
  // The runtime normalises these before anything here sees them, so the checks below are
  // about the normalised host. This pins that the runtime still does.
  it.each([
    ['http://2130706433/', '127.0.0.1'],
    ['http://0x7f.1/', '127.0.0.1'],
    ['http://017700000001/', '127.0.0.1'],
    ['http://127.1/', '127.0.0.1'],
    ['http://0/', '0.0.0.0'],
    ['http://[::ffff:127.0.0.1]/', '[::ffff:7f00:1]'],
    ['http://[0:0:0:0:0:0:0:1]/', '[::1]'],
    ['http://LOCALHOST./', 'localhost.'],
  ])('%s is dialled as %s', (input, host) => {
    expect(new URL(input).hostname).toBe(host);
  });
});

const lenient: OutboundUrlPolicy = {
  schemes: ['https', 'http'],
  ports: [80, 443, 8080],
  maxUrlLength: 2048,
};

const why = (input: string, policy?: OutboundUrlPolicy) => {
  const result = checkOutboundUrl(input, policy);
  return result.ok ? 'ok' : result.reason;
};

describe('outbound URLs', () => {
  it.each([
    'https://example.com/',
    'https://example.com/a/b?c=d#e',
    'https://api.resend.com/emails',
    'https://sub.domain.example.co.uk:443/x',
    'https://xn--r8jz45g.jp/',
    'https://[2606:4700:4700::1111]/',
    'https://8.8.8.8/',
  ])('accepts %s', (input) => {
    expect(why(input)).toBe('ok');
  });

  it.each([
    ['http://example.com/', 'scheme'],
    ['ftp://example.com/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['gopher://example.com/', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/plain,x', 'scheme'],
    ['ws://example.com/', 'scheme'],
    ['https://user@example.com/', 'credentials'],
    ['https://user:pass@example.com/', 'credentials'],
    ['https://:pass@example.com/', 'credentials'],
    ['https://example.com:8443/', 'port'],
    ['https://example.com:22/', 'port'],
    ['https://example.com:80/', 'port'],
    ['https://example.com:6379/', 'port'],
    ['https://localhost/', 'local_name'],
    ['https://LOCALHOST/', 'local_name'],
    ['https://localhost./', 'local_name'],
    ['https://foo.localhost/', 'local_name'],
    ['https://printer.local/', 'local_name'],
    ['https://db.internal/', 'local_name'],
    ['https://metadata.google.internal/', 'local_name'],
    ['https://router.lan/', 'local_name'],
    ['https://nas.home.arpa/', 'local_name'],
    ['https://intranet/', 'single_label'],
    ['https://db/', 'single_label'],
    ['https://127.0.0.1/', 'loopback'],
    ['https://2130706433/', 'loopback'],
    ['https://0x7f.1/', 'loopback'],
    ['https://017700000001/', 'loopback'],
    ['https://127.1/', 'loopback'],
    ['https://[::1]/', 'loopback'],
    ['https://[::ffff:127.0.0.1]/', 'loopback'],
    ['https://10.1.2.3/', 'private'],
    ['https://192.168.0.1/', 'private'],
    ['https://169.254.169.254/latest/meta-data/', 'metadata'],
    ['https://[fd00:ec2::254]/', 'metadata'],
    ['https://100.100.100.200/', 'metadata'],
    ['https://0.0.0.0/', 'unspecified'],
    ['https://[fe80::1]/', 'link_local'],
    ['https://[fc00::1]/', 'unique_local'],
    ['https://224.0.0.1/', 'multicast'],
    ['not a url', 'malformed'],
    ['', 'malformed'],
    ['https://', 'malformed'],
    ['//example.com/', 'malformed'],
    ['example.com', 'malformed'],
    ['https://exa\tmple.com/', 'malformed'],
    ['https://example.com/\n', 'malformed'],
    ['https://exa mple.com/', 'malformed'],
    ['https://example.com/\u0000', 'malformed'],
  ])('refuses %j as %s', (input, reason) => {
    expect(why(input)).toBe(reason);
  });

  it('refuses a URL that is too long, before parsing it', () => {
    expect(why(`https://example.com/${'a'.repeat(2100)}`)).toBe('too_long');
    expect(why(`https://example.com/${'a'.repeat(2000)}`)).toBe('ok');
  });

  it('lets the policy widen the scheme and the ports, and no further', () => {
    expect(why('http://example.com/', lenient)).toBe('ok');
    expect(why('http://example.com:8080/', lenient)).toBe('ok');
    expect(why('http://example.com:9090/', lenient)).toBe('port');
    // Widening scheme and port never widens the address rules.
    expect(why('http://127.0.0.1:8080/', lenient)).toBe('loopback');
    expect(why('http://localhost:8080/', lenient)).toBe('local_name');
    expect(why('http://169.254.169.254/', lenient)).toBe('metadata');
  });

  it('pins to named hosts when asked, exactly or by subdomain', () => {
    const pinned: OutboundUrlPolicy = {
      schemes: ['https'],
      ports: [443],
      maxUrlLength: 2048,
      allowedHosts: ['api.resend.com', '*.example.org'],
    };
    expect(why('https://api.resend.com/emails', pinned)).toBe('ok');
    expect(why('https://API.RESEND.COM./emails', pinned)).toBe('ok');
    expect(why('https://a.example.org/', pinned)).toBe('ok');
    expect(why('https://a.b.example.org/', pinned)).toBe('ok');
    expect(why('https://example.org/', pinned)).toBe('host_not_allowed');
    expect(why('https://evilexample.org/', pinned)).toBe('host_not_allowed');
    expect(why('https://api.resend.com.evil.test/', pinned)).toBe('host_not_allowed');
    expect(why('https://evil.test/api.resend.com', pinned)).toBe('host_not_allowed');
    expect(why('https://xapi.resend.com/', pinned)).toBe('host_not_allowed');
  });

  it('refuses a space anywhere in a URL, even where the parser would encode it', () => {
    expect(why('https://example.com/a b')).toBe('malformed');
    expect(why('https://example.com/?q=a b')).toBe('malformed');
    expect(why('https://example.com/a%20b')).toBe('ok');
  });

  it('judges the default port of the scheme it was given', () => {
    const plain: OutboundUrlPolicy = { schemes: ['http'], ports: [80], maxUrlLength: 2048 };
    expect(why('http://example.com/', plain)).toBe('ok');
    expect(why('http://example.com:80/', plain)).toBe('ok');
    expect(why('http://example.com:443/', plain)).toBe('port');
    const secure: OutboundUrlPolicy = { schemes: ['https'], ports: [443], maxUrlLength: 2048 };
    expect(why('https://example.com/', secure)).toBe('ok');
  });

  it('matches a pinned host without regard to case, in the pin as well as the URL', () => {
    const pinned: OutboundUrlPolicy = {
      schemes: ['https'],
      ports: [443],
      maxUrlLength: 2048,
      allowedHosts: ['API.Resend.com', '*.Example.ORG'],
    };
    expect(why('https://api.resend.com/', pinned)).toBe('ok');
    expect(why('https://A.EXAMPLE.org/', pinned)).toBe('ok');
    expect(why('https://other.resend.com/', pinned)).toBe('host_not_allowed');
  });

  it('does not let a wildcard pin match the suffix alone', () => {
    const pinned: OutboundUrlPolicy = {
      schemes: ['https'],
      ports: [443],
      maxUrlLength: 2048,
      allowedHosts: ['*.example.org'],
    };
    // The URL parser keeps a leading dot, so this host is exactly the suffix.
    expect(why('https://.example.org/', pinned)).toBe('host_not_allowed');
    expect(why('https://x.example.org/', pinned)).toBe('ok');
  });

  it('says whether the host was an address, so a caller knows no lookup is needed', () => {
    const literal = checkOutboundUrl('https://8.8.8.8/');
    const named = checkOutboundUrl('https://example.com/');
    expect(literal.ok && literal.hostIsAddress).toBe(true);
    expect(named.ok && named.hostIsAddress).toBe(false);
    const v6 = checkOutboundUrl('https://[2606:4700:4700::1111]/');
    expect(v6.ok && v6.hostIsAddress).toBe(true);
  });

  it('returns the normalised URL, so the caller dials what was checked', () => {
    const result = checkOutboundUrl('https://EXAMPLE.com:443/a/../b');
    expect(result.ok && result.url.href).toBe('https://example.com/b');
  });
});
