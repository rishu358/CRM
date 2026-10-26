import { classifyAddress, type AddressDecision } from '@crm/core';
import { GuardedOutboundHttp, type GuardedClientOptions } from './client.js';
import type { OutboundHttp } from './types.js';

/**
 * Only for tests (ADR-0040).
 *
 * A test of a client that refuses loopback needs a server on loopback, so this swaps
 * the address rule for one that also allows it. Nothing outside a `*.spec.ts` may import
 * this module: `boundary.spec.ts` fails the build if anything does.
 */
export const allowLoopbackToo = (address: string): AddressDecision => {
  const decision = classifyAddress(address);
  return !decision.allowed && decision.reason === 'loopback'
    ? { allowed: true, family: decision.family ?? 4 }
    : decision;
};

export function createUnsafeOutboundHttpForTests(options: GuardedClientOptions): OutboundHttp {
  return new GuardedOutboundHttp({ addressRule: allowLoopbackToo, ...options });
}
