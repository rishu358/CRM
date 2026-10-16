import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';

/**
 * UUIDv7 identity (ADR-0003).
 *
 * IDs are minted here and nowhere else. They are generated in the application
 * rather than by the database so that a record's identity exists *before* the
 * INSERT — the outbox event and audit entry for a creation need the id while
 * still inside the same transaction.
 */

/** A branded UUID string. The brand stops a raw string being passed as an id. */
export type Uuid = string & { readonly __brand: 'Uuid' };

/** Mint a new time-sortable UUIDv7. */
export function newId(): Uuid {
  return uuidv7() as Uuid;
}

/** True when `value` is a syntactically valid UUID of any version. */
export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && uuidValidate(value);
}

/**
 * True only for UUIDv7.
 *
 * Used where we must reject an id we did not mint — for example a client-supplied
 * cursor. Note this is a *format* check, never an authorization check: proving a
 * string is a v7 UUID says nothing about whether the caller may see that record.
 */
export function isUuidV7(value: unknown): value is Uuid {
  return isUuid(value) && uuidVersion(value) === 7;
}

/**
 * The creation instant embedded in a UUIDv7's leading 48 bits.
 *
 * Only meaningful for v7 ids; returns null for anything else. Useful for
 * diagnostics and for sanity-checking keyset cursors, not as a substitute for
 * the `created_at` column, which is the authoritative value.
 */
export function timestampFromUuidV7(value: string): Date | null {
  if (!isUuidV7(value)) return null;
  const hex = value.replace(/-/g, '').slice(0, 12);
  return new Date(Number.parseInt(hex, 16));
}

/** Parse an untrusted value into a Uuid, or throw. Call at trust boundaries. */
export function assertUuid(value: unknown, label = 'id'): Uuid {
  if (!isUuid(value)) {
    throw new TypeError(`Expected ${label} to be a UUID`);
  }
  return value;
}
