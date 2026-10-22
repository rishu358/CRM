/**
 * Which network addresses a server may be sent to (CLAUDE.md §5.13, ADR-0040).
 *
 * The rule is **default deny**. An address is allowed only if it is globally routable
 * public space, and what is not is named so the reason can be logged and tested:
 * "this is the cloud metadata service" and "this is a private network" are different
 * incidents even though both are refused.
 *
 * Pure and dependency-free: no DNS, no sockets. The client that connects lives in
 * `@crm/outbound`; this only answers "may I connect to that?", for an address already
 * resolved, so it can be tested exhaustively and reused wherever an address appears.
 */

export type BlockReason =
  | 'not_an_address'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'metadata'
  | 'carrier_grade_nat'
  | 'multicast'
  | 'documentation'
  | 'reserved'
  | 'translation'
  | 'unique_local';

export type AddressDecision =
  | { readonly allowed: true; readonly family: 4 | 6 }
  | { readonly allowed: false; readonly reason: BlockReason; readonly family: 4 | 6 | null };

/* -------------------------------------------------------------------------- */
/* IPv4                                                                       */
/* -------------------------------------------------------------------------- */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * A strict dotted quad as a 32-bit number, or null.
 *
 * Strict on purpose: no leading zeros (`010.0.0.1` is octal to some parsers and
 * decimal to others, which is the whole bug), no hex, no short forms. The URL parser
 * normalises those spellings before an address reaches here; anything that still
 * does not parse is refused rather than interpreted.
 */
export function parseIpv4(text: string): number | null {
  const match = IPV4.exec(text);
  if (match === null) return null;
  let value = 0;
  for (const part of match.slice(1)) {
    if (part.length > 1 && part.startsWith('0')) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

interface Ipv4Range {
  readonly start: number;
  readonly bits: number;
  readonly reason: BlockReason;
}

function range4(address: string, bits: number, reason: BlockReason): Ipv4Range {
  const start = parseIpv4(address);
  if (start === null) throw new Error(`Bad range ${address}`);
  return { start, bits, reason };
}

/** Everything that is not globally routable, per IANA's special-purpose registry. */
const BLOCKED_IPV4: readonly Ipv4Range[] = [
  range4('0.0.0.0', 8, 'unspecified'),
  range4('10.0.0.0', 8, 'private'),
  range4('100.64.0.0', 10, 'carrier_grade_nat'),
  range4('127.0.0.0', 8, 'loopback'),
  // The metadata service sits inside link-local; it is named separately first below.
  range4('169.254.0.0', 16, 'link_local'),
  range4('172.16.0.0', 12, 'private'),
  range4('192.0.0.0', 24, 'reserved'),
  range4('192.0.2.0', 24, 'documentation'),
  range4('192.88.99.0', 24, 'reserved'),
  range4('192.168.0.0', 16, 'private'),
  range4('198.18.0.0', 15, 'reserved'),
  range4('198.51.100.0', 24, 'documentation'),
  range4('203.0.113.0', 24, 'documentation'),
  range4('224.0.0.0', 4, 'multicast'),
  range4('240.0.0.0', 4, 'reserved'),
];

const METADATA_IPV4 = parseIpv4('169.254.169.254');
/** AWS' IPv6 metadata endpoint is `fd00:ec2::254`; Alibaba's is `100.100.100.200`. */
const ALIBABA_METADATA = parseIpv4('100.100.100.200');

function inRange4(value: number, range: Ipv4Range): boolean {
  const size = 2 ** (32 - range.bits);
  return value >= range.start && value < range.start + size;
}

function decide4(value: number): AddressDecision {
  if (value === METADATA_IPV4 || value === ALIBABA_METADATA) {
    return { allowed: false, reason: 'metadata', family: 4 };
  }
  for (const range of BLOCKED_IPV4) {
    if (inRange4(value, range)) return { allowed: false, reason: range.reason, family: 4 };
  }
  return { allowed: true, family: 4 };
}

/* -------------------------------------------------------------------------- */
/* IPv6                                                                       */
/* -------------------------------------------------------------------------- */

const HEXTET = /^[0-9a-fA-F]{1,4}$/;

/**
 * An IPv6 address as eight 16-bit groups, or null.
 *
 * Accepts `::` compression and a trailing dotted IPv4 (`::ffff:1.2.3.4`); refuses a
 * zone id (`fe80::1%eth0`), which names an interface and has no business in a URL a
 * user gave us, and anything malformed.
 */
export function parseIpv6(text: string): number[] | null {
  if (text.includes('%')) return null;
  let working = text;
  const groups: number[] = [];

  // A dotted tail stands in for the last two groups.
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  let tailGroups: number[] = [];
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    tailGroups = [Math.floor(v4 / 65536), v4 % 65536];
    working = `${working.slice(0, lastColon + 1)}0:0`;
  }

  const doubleColon = working.split('::');
  if (doubleColon.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const pieces = part.split(':');
    const out: number[] = [];
    for (const piece of pieces) {
      if (!HEXTET.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = parse(doubleColon[0] ?? '');
  if (head === null) return null;

  if (doubleColon.length === 1) {
    if (head.length !== 8) return null;
    groups.push(...head);
  } else {
    const rest = parse(doubleColon[1] ?? '');
    if (rest === null) return null;
    // `::` stands for at least one group of zeros.
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups.push(...head, ...Array.from({ length: missing }, () => 0), ...rest);
  }

  if (groups.length !== 8) return null;
  if (tailGroups.length === 2) {
    groups[6] = tailGroups[0] ?? 0;
    groups[7] = tailGroups[1] ?? 0;
  }
  return groups;
}

function toBigInt(groups: readonly number[]): bigint {
  return groups.reduce((total, group) => (total << 16n) | BigInt(group), 0n);
}

function prefix6(address: string, bits: number): { value: bigint; bits: number } {
  const groups = parseIpv6(address);
  if (groups === null) throw new Error(`Bad prefix ${address}`);
  return { value: toBigInt(groups), bits };
}

function within6(value: bigint, prefix: { value: bigint; bits: number }): boolean {
  const shift = BigInt(128 - prefix.bits);
  return value >> shift === prefix.value >> shift;
}

/** Global unicast. Everything outside it is refused without being listed. */
const GLOBAL_UNICAST = prefix6('2000::', 3);

/** Carved out of global unicast: not routable public destinations. */
const BLOCKED_WITHIN_GLOBAL: readonly {
  prefix: { value: bigint; bits: number };
  reason: BlockReason;
}[] = [
  { prefix: prefix6('2001::', 23), reason: 'reserved' }, // IETF protocol assignments, Teredo, ORCHID
  { prefix: prefix6('2001:db8::', 32), reason: 'documentation' },
  { prefix: prefix6('2002::', 16), reason: 'translation' }, // 6to4: an IPv4 address in disguise
  { prefix: prefix6('3fff::', 20), reason: 'documentation' },
];

const MAPPED = prefix6('::ffff:0:0', 96);
const NAT64 = prefix6('64:ff9b::', 96);
const NAT64_LOCAL = prefix6('64:ff9b:1::', 48);
const AWS_METADATA_V6 = toBigInt(parseIpv6('fd00:ec2::254') ?? []);

function decide6(groups: readonly number[]): AddressDecision {
  const value = toBigInt(groups);

  // `::ffff:127.0.0.1` is loopback wearing a different hat, and is how a naive
  // IPv6-only check lets an IPv4 target through. Judge the address inside.
  if (within6(value, MAPPED)) {
    const embedded = Number(value & 0xffffffffn);
    const decision = decide4(embedded);
    return decision.allowed
      ? { allowed: false, reason: 'translation', family: 6 }
      : { ...decision, family: 6 };
  }
  if (within6(value, NAT64) || within6(value, NAT64_LOCAL)) {
    return { allowed: false, reason: 'translation', family: 6 };
  }
  if (value === 0n) return { allowed: false, reason: 'unspecified', family: 6 };
  if (value === 1n) return { allowed: false, reason: 'loopback', family: 6 };
  if (value === AWS_METADATA_V6) return { allowed: false, reason: 'metadata', family: 6 };

  const top = groups[0] ?? 0;
  if ((top & 0xff00) === 0xff00) return { allowed: false, reason: 'multicast', family: 6 };
  if ((top & 0xfe00) === 0xfc00) return { allowed: false, reason: 'unique_local', family: 6 };
  if ((top & 0xffc0) === 0xfe80) return { allowed: false, reason: 'link_local', family: 6 };

  if (!within6(value, GLOBAL_UNICAST)) return { allowed: false, reason: 'reserved', family: 6 };
  for (const blocked of BLOCKED_WITHIN_GLOBAL) {
    if (within6(value, blocked.prefix)) {
      return { allowed: false, reason: blocked.reason, family: 6 };
    }
  }
  return { allowed: true, family: 6 };
}

/* -------------------------------------------------------------------------- */
/* The one entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * May a server connect to this address?
 *
 * Takes the textual form a resolver or a URL gives: a dotted quad, or an IPv6 address
 * with or without the brackets a URL host carries. Anything else is `not_an_address`
 * and refused: the caller resolved a name and got something that is not an address,
 * and guessing is how this class of bug starts.
 */
export function classifyAddress(text: string): AddressDecision {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;

  const v4 = parseIpv4(bare);
  if (v4 !== null) return decide4(v4);

  const v6 = parseIpv6(bare);
  if (v6 !== null) return decide6(v6);

  return { allowed: false, reason: 'not_an_address', family: null };
}
