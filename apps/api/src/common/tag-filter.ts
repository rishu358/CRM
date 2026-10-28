import { ValidationError, type BusinessObjectType } from '@crm/core';
import type { ParsedFilter } from '@crm/contracts';
import { isTagFilterOperator, tagFilterSql, type SQL } from '@crm/db';

/**
 * `tags:has_any:<ids>` and `tags:has_none:<ids>` on a list (ADR-0063).
 *
 * Each object module's `filterToSql` hands the `tags` pseudo-field here before it looks for a column,
 * so the four lists build the identical predicate (the one an export and a saved view use too, in
 * `@crm/db`). The tag operators are valid on that one field only; everywhere else they are a 422.
 */
export function tagsFilterToSql(
  objectType: BusinessObjectType,
  filter: ParsedFilter,
  columns: { readonly id: SQL; readonly tenantId: SQL },
): SQL {
  if (!isTagFilterOperator(filter.operator)) {
    throw new ValidationError([
      { path: filter.field, message: `Cannot use "${filter.operator}" on this field` },
    ]);
  }
  return tagFilterSql({
    field: filter.field,
    objectType,
    operator: filter.operator,
    value: filter.value,
    idColumn: columns.id,
    tenantColumn: columns.tenantId,
  });
}

/** The operators that belong to the `tags` field alone, refused on any column. */
export function refuseTagOperator(filter: ParsedFilter): never {
  throw new ValidationError([
    { path: filter.field, message: `Cannot use "${filter.operator}" on this field` },
  ]);
}
