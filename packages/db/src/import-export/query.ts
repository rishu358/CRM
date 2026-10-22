import {
  isUuid,
  QUERY_COLUMNS,
  ValidationError,
  type ColumnKind,
  type ExportableObjectType,
  type FieldDefinition,
  type RecordConstraint,
} from '@crm/core';
import { sql, type SQL } from 'drizzle-orm';
import { constraintToSql } from '../record-scope.js';
import { LIKE_ESCAPE, OBJECT_DESCRIPTORS, type ObjectDescriptor } from './descriptors.js';

/**
 * The export's query: the list endpoint's filter, sort and search, rebuilt
 * beside the descriptors (MVP_SPEC §M8, ADR-0029).
 *
 * **This is a copy**, and the honest thing to say first is why. The list
 * endpoints build this SQL in each module's `sql-helpers.ts`, inside the API,
 * and the worker that runs exports cannot import the API. Lifting the four
 * copies into one shared implementation would touch four merged modules to
 * remove duplication; ADR-0029 records that as a follow-up rather than a
 * decision against it.
 *
 * What stops this copy from rotting is `exports.parity.security.spec.ts` in the
 * API: it runs the same filters through the real list endpoint and through this
 * builder and fails when they return different rows, and fails when the sets of
 * keys each accepts differ. If this drifts from a module, a test goes red.
 *
 * Everything a client controls — a sort key, a filter field, an operator — is
 * resolved against a whitelist before it becomes SQL, and values are always
 * bound parameters (CLAUDE.md §5.7). Callers pass filters already parsed; the
 * string syntax belongs to `@crm/contracts`, which this package does not use.
 */

const NUMERIC = /^-?\d{1,19}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `ParsedFilter` from `@crm/contracts`, structurally. */
export interface QueryFilter {
  readonly field: string;
  readonly operator:
    | 'eq'
    | 'neq'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
    | 'contains'
    | 'starts_with'
    | 'in'
    | 'is_null'
    | 'is_not_null';
  readonly value: string;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

export interface ResolvedColumn {
  readonly expression: SQL;
  readonly kind: ColumnKind;
}

/** A field key to SQL, or a 422 (an unknown key is never a silent fallback). */
export function resolveColumn(
  objectType: ExportableObjectType,
  descriptor: ObjectDescriptor,
  key: string,
  fields: readonly FieldDefinition[],
): ResolvedColumn {
  const kind = Object.hasOwn(QUERY_COLUMNS[objectType], key)
    ? QUERY_COLUMNS[objectType][key]
    : undefined;
  const standard = descriptor.columns[key];
  if (kind !== undefined && standard !== undefined) return { expression: standard, kind };

  const custom = fields.find((field) => field.key === key && field.isActive && !field.isSystem);
  if (custom === undefined) throw new ValidationError([{ path: key, message: 'Unknown field' }]);

  // The key is a bound parameter, not text in the statement. `->>` yields text
  // whatever the field's declared type, so a custom field compares as text.
  return { expression: sql`(${descriptor.customFields} ->> ${key})`, kind: 'text' };
}

function assertComparable(field: string, kind: ColumnKind, value: string): void {
  const problem =
    kind === 'number' && !NUMERIC.test(value)
      ? 'Expected a whole number'
      : kind === 'uuid' && !isUuid(value)
        ? 'Expected an id'
        : kind === 'timestamp' && !TIMESTAMP.test(value)
          ? 'Expected a date, as YYYY-MM-DD or an ISO-8601 timestamp'
          : kind === 'date' && !DATE.test(value)
            ? 'Expected a date, as YYYY-MM-DD'
            : null;
  if (problem !== null) throw new ValidationError([{ path: field, message: problem }]);
}

function cast(kind: ColumnKind, value: string): SQL {
  switch (kind) {
    case 'text':
      return sql`${value}`;
    case 'number':
      return sql`${value}::bigint`;
    case 'uuid':
      return sql`${value}::uuid`;
    case 'timestamp':
      return sql`${value}::timestamptz`;
    case 'date':
      return sql`${value}::date`;
  }
}

export function filterToSql(filter: QueryFilter, column: ResolvedColumn): SQL {
  const { expression, kind } = column;
  const comparable = (): SQL => {
    assertComparable(filter.field, kind, filter.value);
    return cast(kind, filter.value);
  };
  const assertTextual = (): void => {
    if (kind !== 'text') {
      throw new ValidationError([
        { path: filter.field, message: `Cannot use "${filter.operator}" on this field` },
      ]);
    }
  };

  switch (filter.operator) {
    case 'eq':
      return sql`${expression} = ${comparable()}`;
    case 'neq':
      return sql`${expression} is distinct from ${comparable()}`;
    case 'lt':
      return sql`${expression} < ${comparable()}`;
    case 'lte':
      return sql`${expression} <= ${comparable()}`;
    case 'gt':
      return sql`${expression} > ${comparable()}`;
    case 'gte':
      return sql`${expression} >= ${comparable()}`;
    case 'contains':
      assertTextual();
      return sql`${expression} ilike ${`%${escapeLikePattern(filter.value)}%`} escape ${LIKE_ESCAPE}`;
    case 'starts_with':
      assertTextual();
      return sql`${expression} ilike ${`${escapeLikePattern(filter.value)}%`} escape ${LIKE_ESCAPE}`;
    case 'in': {
      const values = filter.value.split(',').filter((value) => value.length > 0);
      if (values.length === 0) return sql`false`;
      if (values.length > 100) {
        throw new ValidationError([
          { path: filter.field, message: 'An "in" filter accepts at most 100 values' },
        ]);
      }
      for (const value of values) assertComparable(filter.field, kind, value);
      return sql`${expression} in (${sql.join(
        values.map((value) => cast(kind, value)),
        sql`, `,
      )})`;
    }
    case 'is_null':
      return sql`${expression} is null`;
    case 'is_not_null':
      return sql`${expression} is not null`;
  }
}

/**
 * The keyset predicate: strictly after `(value, id)` in the chosen direction
 * (ADR-0012). Copied from the API's `common/keyset.ts`, with the same two
 * traps its comment describes: the whole thing must be parenthesised or an
 * embedded `or` escapes the WHERE clause and drops the scope predicate, and
 * NULLs have a side.
 */
export function keysetPredicate(
  sortExpression: SQL,
  idColumn: SQL,
  direction: 'asc' | 'desc',
  cursor: { readonly value: string | null; readonly id: string },
): SQL {
  if (direction === 'asc') {
    return cursor.value === null
      ? sql`(${sortExpression} is null and ${idColumn} > ${cursor.id}::uuid)`
      : sql`((${sortExpression}, ${idColumn}) > (${cursor.value}, ${cursor.id}::uuid)
             or ${sortExpression} is null)`;
  }
  return cursor.value === null
    ? sql`((${sortExpression} is null and ${idColumn} < ${cursor.id}::uuid)
           or ${sortExpression} is not null)`
    : sql`((${sortExpression}, ${idColumn}) < (${cursor.value}, ${cursor.id}::uuid))`;
}

export interface QueryPlan {
  readonly descriptor: ObjectDescriptor;
  /** Predicates that apply to every page: scope, filters, search. */
  readonly where: SQL[];
  readonly sort: SQL;
  readonly direction: 'asc' | 'desc';
}

export function planQuery(
  objectType: ExportableObjectType,
  fields: readonly FieldDefinition[],
  query: {
    readonly filters: readonly QueryFilter[];
    readonly sort?: { readonly field: string; readonly direction: 'asc' | 'desc' } | undefined;
    readonly q?: string | undefined;
    /** The searchable fields the caller may read; `q` looks in these and no others. */
    readonly searchFields?: readonly string[] | undefined;
  },
  constraint: RecordConstraint,
): QueryPlan {
  const descriptor = OBJECT_DESCRIPTORS[objectType];
  const where: SQL[] = [];

  const scope = constraintToSql(constraint, descriptor.ownerId);
  if (scope !== undefined) where.push(scope);

  for (const filter of query.filters) {
    where.push(filterToSql(filter, resolveColumn(objectType, descriptor, filter.field, fields)));
  }

  if (query.q !== undefined && query.q !== '') {
    where.push(descriptor.search(`%${escapeLikePattern(query.q)}%`, query.searchFields ?? []));
  }

  const sort = query.sort ?? { field: 'created_at', direction: 'asc' as const };
  return {
    descriptor,
    where,
    sort: resolveColumn(objectType, descriptor, sort.field, fields).expression,
    direction: sort.direction,
  };
}

/** One page after `cursor`, in plan order. The unit an export (or a test) loops on. */
export async function selectPlanPage(
  tx: Parameters<ObjectDescriptor['selectPage']>[0],
  tenantId: string,
  plan: QueryPlan,
  options: { limit: number; cursor: { value: string | null; id: string } | null },
) {
  const where = [...plan.where];
  if (options.cursor !== null) {
    where.push(keysetPredicate(plan.sort, plan.descriptor.id, plan.direction, options.cursor));
  }
  return plan.descriptor.selectPage(tx, {
    tenantId,
    where,
    sort: plan.sort,
    direction: plan.direction,
    limit: options.limit,
  });
}
