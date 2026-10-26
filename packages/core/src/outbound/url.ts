import { classifyAddress, type AddressDecision, type BlockReason } from './addresses.js';

/**
 * Which URLs a server may be asked to fetch (CLAUDE.md §5.13, ADR-0040).
 *
 * The address check in `addresses.ts` is what actually protects the network; this is
 * the layer in front of it that refuses a request *before* any DNS lookup is spent on
 * it, and that refuses spellings no honest caller uses. A URL is parsed once, by the
 * WHATWG parser the runtime uses to connect, so what is checked here is what would be
 * dialled: `http://2130706433/` and `http://0x7f.1/` both arrive as `127.0.0.1`.
 */

export type UrlRefusal =
  | 'malformed'
  | 'too_long'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'host_not_allowed'
  | 'local_name'
  | 'single_label'
  | BlockReason;

export interface OutboundUrlPolicy {
  /** `https` unless a caller has a reason; plain `http` is for a test server and nothing else. */
  readonly schemes: readonly ('https' | 'http')[];
  /** Ports that may be dialled. A request for another is refused, not rewritten. */
  readonly ports: readonly number[];
  /**
   * When set, the host must equal an entry or be a subdomain of one written `*.example.com`.
   * A caller that talks to one vendor (the email provider) pins it here, so a stored URL
   * edited to point elsewhere is refused whatever address it resolves to.
   */
  readonly allowedHosts?: readonly string[];
  readonly maxUrlLength: number;
}

export const DEFAULT_OUTBOUND_URL_POLICY: OutboundUrlPolicy = {
  schemes: ['https'],
  ports: [443],
  maxUrlLength: 2048,
};

export type UrlCheck =
  | { readonly ok: true; readonly url: URL; readonly hostIsAddress: boolean }
  | { readonly ok: false; readonly reason: UrlRefusal };

/** Name suffixes that mean "somewhere on a private network", never the public internet. */
const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.home.arpa',
];

/** Control characters, space and DEL: none belongs in a URL somebody typed. */
function hasUnprintable(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'https:': 443, 'http:': 80 };

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith('*.'))
      return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
    return host === pattern;
  });
}

/**
 * `classify` is the rule for a literal address in the host. It is a parameter so the
 * client's tests can allow loopback for a test server; the client's public constructor
 * never exposes it, so production code is always judged by `classifyAddress`.
 */
export function checkOutboundUrl(
  input: string,
  policy: OutboundUrlPolicy = DEFAULT_OUTBOUND_URL_POLICY,
  classify: (address: string) => AddressDecision = classifyAddress,
): UrlCheck {
  if (input.length > policy.maxUrlLength) return { ok: false, reason: 'too_long' };
  // The parser silently strips tabs and newlines from the middle of a URL, so what it
  // dials is not what was written. Anything that is not plain printable text is refused.
  if (hasUnprintable(input)) return { ok: false, reason: 'malformed' };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!policy.schemes.some((scheme) => `${scheme}:` === url.protocol)) {
    return { ok: false, reason: 'scheme' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };

  const port = url.port === '' ? (DEFAULT_PORTS[url.protocol] ?? 0) : Number(url.port);
  if (!policy.ports.includes(port)) return { ok: false, reason: 'port' };

  // `localhost.` and `localhost` are the same name; a trailing dot must not be a way round.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return { ok: false, reason: 'malformed' };

  const literal = classify(host);
  const hostIsAddress = literal.allowed || literal.reason !== 'not_an_address';
  if (hostIsAddress) {
    if (!literal.allowed) return { ok: false, reason: literal.reason };
  } else {
    if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return { ok: false, reason: 'local_name' };
    }
    // A name with no dot is resolved against the server's search domains, which is
    // exactly how `http://intranet/` reaches a private host.
    if (!host.includes('.')) return { ok: false, reason: 'single_label' };
  }

  if (policy.allowedHosts !== undefined && !hostAllowed(host, policy.allowedHosts)) {
    return { ok: false, reason: 'host_not_allowed' };
  }

  return { ok: true, url, hostIsAddress };
}
