import { isIP } from 'node:net';

/**
 * Tell the API who is really asking (ADR-0042).
 *
 * Every browser request reaches the API through this server, so without help the API sees one address,
 * this server's, for every person. The address limits and the sign-in limit would then be one budget
 * shared by everyone: fifty sign-ins from the whole user base in fifteen minutes and nobody could sign
 * in. So the address the front proxy saw (Caddy sets `X-Forwarded-For` to the client's address and
 * discards any the client sent, the same trust `proxy.ts` places in `X-Forwarded-Proto`) is passed on.
 *
 * Only a single, well-formed IP address is forwarded, so a malformed or multi-hop value can neither
 * confuse the API nor smuggle in anything else; with none, the API falls back to this server's address.
 * The API trusts the value (`trustProxy`), which is safe only while it is reachable from this server
 * and the proxy alone: RUNBOOK §1 keeps it on the private network.
 */
export function clientAddressHeaders(incoming: Headers): Record<string, string> {
  const first = incoming.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (first === undefined || first === '' || isIP(first) === 0) return {};
  return { 'x-forwarded-for': first };
}
