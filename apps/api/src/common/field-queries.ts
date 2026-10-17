import { canReadField, ValidationError, type Actor, type ObjectType } from '@crm/core';
import type { ParsedFilter } from '@crm/contracts';

/**
 * Sorting and filtering are reads (CLAUDE.md §5.4, §5.7).
 *
 * The field whitelist answers "is this a real field"; this answers "may this
 * caller see it". Both are needed. A caller who cannot read a column can still
 * learn its contents through ordering and comparison — `filter=gstin:starts_with:29`
 * answered as a row count is a character-at-a-time read of a hidden value, and
 * `sort=gstin` is its ordering. Slower than reading the column, not smaller.
 *
 * A field the caller may not read is reported **exactly** as one that does not
 * exist, so the error cannot be used to discover which fields are concealed.
 */

/** May this actor sort by this key, given the object's field metadata? */
export function assertSortable(
  actor: Actor,
  objectType: ObjectType,
  field: string,
  allowedKeys: readonly string[],
): void {
  if (allowedKeys.includes(field) && canReadField(actor, objectType, field)) return;
  throw new ValidationError([{ path: 'sort', message: `Cannot sort by ${field}` }]);
}

/**
 * Drop nothing, reject anything the actor may not read.
 *
 * Whether the field exists at all is settled later, in the SQL helper that
 * resolves it against `field_definitions` — with the same message.
 */
export function assertFiltersReadable(
  actor: Actor,
  objectType: ObjectType,
  filters: readonly ParsedFilter[],
): void {
  for (const filter of filters) {
    if (!canReadField(actor, objectType, filter.field)) {
      throw new ValidationError([{ path: filter.field, message: 'Unknown field' }]);
    }
  }
}
