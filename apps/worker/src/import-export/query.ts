import { parseFilter, parseSort } from '@crm/contracts';
import {
  ValidationError,
  type ExportableObjectType,
  type FieldDefinition,
  type RecordConstraint,
} from '@crm/core';
import { OBJECT_DESCRIPTORS, planQuery, type QueryPlan } from '@crm/db';

/**
 * An export's stored query, turned into the plan the worker pages through.
 *
 * The SQL itself lives in `@crm/db` (`planQuery`) so the API's parity test can
 * run the identical builder against the real list endpoints. This file owns
 * only the string syntax (`field:operator:value`, `-field`), which belongs to
 * `@crm/contracts`.
 */
export type ExportQueryPlan = QueryPlan;

export function planExportQuery(
  objectType: ExportableObjectType,
  fields: readonly FieldDefinition[],
  query: {
    filter?: readonly string[] | undefined;
    sort?: string | undefined;
    q?: string | undefined;
  },
  constraint: RecordConstraint,
  /** May the caller read this field? `q` only looks in the searchable fields they may. */
  canRead: (fieldKey: string) => boolean,
): ExportQueryPlan {
  const filters = (query.filter ?? []).map((raw) => {
    const parsed = parseFilter(raw);
    if (parsed === null) {
      throw new ValidationError([{ path: 'filter', message: `Malformed filter: ${raw}` }]);
    }
    return parsed;
  });

  return planQuery(
    objectType,
    fields,
    {
      filters,
      sort: query.sort === undefined ? undefined : parseSort(query.sort),
      q: query.q,
      searchFields: OBJECT_DESCRIPTORS[objectType].searchKeys.filter(canRead),
    },
    constraint,
  );
}
