import { ValidationError } from '@crm/core';

/** Opaque, bounded, and boring: it ends up in a unique index. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Read the `Idempotency-Key` header (CLAUDE.md §6).
 *
 * Shared rather than per-controller: the rule for what a key may contain is a
 * property of the API, and two controllers each deciding it would eventually
 * disagree. Absent is fine — idempotency is opt-in for the caller.
 */
export function parseIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(raw)) {
    throw new ValidationError([
      { path: 'Idempotency-Key', message: 'Use 1 to 128 letters, digits, and _ . : -' },
    ]);
  }
  return raw;
}
