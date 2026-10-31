import { createHash } from 'node:crypto';

/**
 * What the block list holds in place of an address (ADR-0075): the SHA-256 of the company and the
 * lower-cased address. The list has to recognise an address, not keep it, so an erasure of a person
 * leaves nothing of theirs there. The company is part of the input so the same address in two companies
 * is two different values.
 */
export function emailSuppressionKey(tenantId: string, address: string): Buffer {
  return createHash('sha256')
    .update(`email-suppression:v1:${tenantId}:${address.trim().toLowerCase()}`, 'utf8')
    .digest();
}
