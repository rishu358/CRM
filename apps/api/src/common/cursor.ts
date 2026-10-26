import { isUuid } from '@crm/core';

/**
 * Keyset cursors (ADR-0012).
 *
 * Shared by every list endpoint rather than living in one module: a second
 * copy of a cursor encoding is a second thing to keep in step, and the first
 * time they disagree a client's saved cursor decodes into the wrong position
 * on one object and not the other.
 *
 * Opaque by contract: clients pass back what they were given and never build
 * one. Encoding it keeps the sort key out of client code, so changing the
 * ordering later is not a breaking API change.
 *
 * This is **not** a security boundary. A cursor is base64, not a signature, and
 * a caller can forge one. That is harmless because the cursor only moves a
 * position within a result set that RLS and the scope constraint have already
 * narrowed — a forged cursor cannot reach a row the caller could not already
 * page to. It is still validated, so a malformed one is a clean 422 rather than
 * a confusing database error.
 */
export interface Cursor {
  /** The sort column's value on the last row of the previous page. */
  readonly value: string | null;
  /** The tiebreak id, which makes the ordering total. */
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { value, id } = parsed as { value?: unknown; id?: unknown };
    if (!isUuid(id)) return null;
    if (value !== null && typeof value !== 'string') return null;

    return { value: value ?? null, id };
  } catch {
    return null;
  }
}
