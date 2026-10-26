import {
  canReadField,
  isStandardQueryColumn,
  QUERY_COLUMNS,
  sortableFieldKeys,
  ValidationError,
  type Actor,
  type BusinessObjectType,
  type FieldDefinition,
} from '@crm/core';
import type { ViewCondition, ViewSort } from '@crm/contracts';
import { planQuery } from '@crm/db';

/**
 * Whether a view's filter, sort and columns are something this caller may use (ADR-0056).
 *
 * Saved views and bulk-by-filter both take a list's query from a client, so both hold it to what
 * the list endpoint would accept: the field must be a real standard column or an **active** custom
 * field, and the caller must be able to **read** it (CLAUDE.md §5.4). A field the caller may not
 * read is reported exactly as one that does not exist, so a 422 cannot be used to find out which
 * fields are hidden. Filtering and sorting are reads: `gstin:starts_with:29` answered as a row
 * count is a character-at-a-time read of a hidden value.
 */

export function filterableKeys(
  objectType: BusinessObjectType,
  fields: readonly FieldDefinition[],
): Set<string> {
  const custom = fields.filter((field) => field.isActive && !field.isSystem).map((f) => f.key);
  return new Set([...Object.keys(QUERY_COLUMNS[objectType]), ...custom]);
}

function sortableKeys(
  objectType: BusinessObjectType,
  fields: readonly FieldDefinition[],
): Set<string> {
  const custom = new Set(
    fields.filter((field) => field.isActive && !field.isSystem).map((f) => f.key),
  );
  return new Set([
    ...Object.keys(QUERY_COLUMNS[objectType]),
    ...sortableFieldKeys(fields).filter(
      (key) => !isStandardQueryColumn(objectType, key) && custom.has(key),
    ),
  ]);
}

const UNKNOWN = (path: string) => new ValidationError([{ path, message: 'Unknown field' }]);

/** Throws a 422 for the first condition, sort or column this caller cannot use. */
export function assertViewQuery(
  actor: Actor,
  objectType: BusinessObjectType,
  fields: readonly FieldDefinition[],
  query: {
    readonly conditions: readonly ViewCondition[];
    readonly sort?: readonly ViewSort[] | undefined;
    readonly columns?: readonly string[] | undefined;
  },
): void {
  const known = filterableKeys(objectType, fields);
  for (const condition of query.conditions) {
    if (!known.has(condition.field) || !canReadField(actor, objectType, condition.field)) {
      throw UNKNOWN(condition.field);
    }
  }

  const sortable = sortableKeys(objectType, fields);
  for (const sort of query.sort ?? []) {
    if (!sortable.has(sort.field) || !canReadField(actor, objectType, sort.field)) {
      throw new ValidationError([{ path: 'sort', message: `Cannot sort by ${sort.field}` }]);
    }
  }

  const active = new Set(fields.filter((field) => field.isActive).map((field) => field.key));
  const seen = new Set<string>();
  for (const column of query.columns ?? []) {
    if (!active.has(column) || !canReadField(actor, objectType, column)) throw UNKNOWN(column);
    if (seen.has(column)) {
      throw new ValidationError([{ path: 'columns', message: `Column ${column} is listed twice` }]);
    }
    seen.add(column);
  }

  // Values: build the plan (no query is run) so a malformed value is a 422 now, with the message
  // the list endpoint gives, instead of an error the first time somebody opens the view.
  planQuery(
    objectType,
    fields,
    {
      filters: query.conditions,
      sort: query.sort?.[0],
    },
    { kind: 'all' },
  );
}

/**
 * True when every field a view's filter and sort use is readable by this caller.
 *
 * Used to mark a shared view as not applicable rather than to reject it: it is somebody else's
 * work, written when they could read a field this caller cannot.
 */
export function viewIsApplicable(
  actor: Actor,
  objectType: BusinessObjectType,
  fields: readonly FieldDefinition[],
  view: { readonly conditions: readonly ViewCondition[]; readonly sort: readonly ViewSort[] },
): boolean {
  const known = filterableKeys(objectType, fields);
  const usable = (key: string) => known.has(key) && canReadField(actor, objectType, key);
  return view.conditions.every((c) => usable(c.field)) && view.sort.every((s) => usable(s.field));
}

/** The columns of a view this caller may read: an unreadable one is dropped, not named. */
export function readableViewColumns(
  actor: Actor,
  objectType: BusinessObjectType,
  fields: readonly FieldDefinition[],
  columns: readonly string[],
): string[] {
  const active = new Set(fields.filter((field) => field.isActive).map((field) => field.key));
  return columns.filter((column) => active.has(column) && canReadField(actor, objectType, column));
}
