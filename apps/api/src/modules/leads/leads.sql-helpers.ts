import { ValidationError, type FieldDefinition, type RecordConstraint } from '@crm/core';
import { sortableFieldKeys } from '@crm/core';
import type { FilterOperator, ParsedFilter } from '@crm/contracts';
import { leads, and, eq, inArray, isNull, or, sql, type SQL } from '@crm/db';
import { constraintToSql as scopeToSql } from '../../common/record-scope.js';

/**
 * SQL fragments for the leads repository.
 *
 * Everything a client can influence — sort key, filter field, filter operator —
 * is resolved against a whitelist here before it becomes SQL (CLAUDE.md §5.7).
 * Values are always bound parameters; nothing is interpolated into a statement.
 */

/**
 * Escape a user's search term for ILIKE.
 *
 * Deliberately **not** backslash. A backslash escape has to survive a
 * JavaScript template literal, a SQL string literal and Postgres's own LIKE
 * parsing, and getting any one of those wrong fails silently: the pattern still
 * runs, it just stops escaping, so a lone `%` quietly matches every row. Using
 * `!` keeps the whole thing backslash-free, and the pattern is built here in
 * JavaScript and bound as a single parameter rather than assembled in SQL.
 */
const LIKE_ESCAPE = '!';

export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

/** Standard columns a caller may sort or filter on, by their API field key. */
const STANDARD_COLUMNS = {
  first_name: leads.firstName,
  last_name: leads.lastName,
  company: leads.company,
  email: leads.email,
  phone: leads.phone,
  source: leads.source,
  status: leads.status,
  owner_id: leads.ownerId,
  converted_at: leads.convertedAt,
  created_at: leads.createdAt,
  updated_at: leads.updatedAt,
} as const;

type StandardColumnKey = keyof typeof STANDARD_COLUMNS;

function isStandardColumn(key: string): key is StandardColumnKey {
  return Object.hasOwn(STANDARD_COLUMNS, key);
}

/**
 * Resolve a client-supplied field key into a SQL expression, or reject it.
 *
 * A key that is neither a standard column nor an **active** field in this
 * tenant's metadata is a 422. Nothing falls through to a default, because a
 * silent fallback is how an unvalidated identifier ends up in a query.
 */
export function expressionForField(key: string, fields: readonly FieldDefinition[]): SQL {
  if (isStandardColumn(key)) {
    return sql`${STANDARD_COLUMNS[key]}`;
  }

  const custom = fields.find((field) => field.key === key && field.isActive && !field.isSystem);
  if (custom === undefined) {
    throw new ValidationError([{ path: key, message: 'Unknown field' }]);
  }

  // The key is a bound parameter, not string-concatenated into the statement.
  return sql`(${leads.customFields} ->> ${key})`;
}

/** The keys a caller may sort by: standard columns plus sortable custom fields. */
export function allowedSortKeys(fields: readonly FieldDefinition[]): string[] {
  const custom = sortableFieldKeys(fields).filter((key) => !isStandardColumn(key));
  return [...Object.keys(STANDARD_COLUMNS), ...custom];
}

/**
 * The actor's record scope as a WHERE clause (ADR-0008).
 *
 * The rule itself is shared (`common/record-scope.ts`); this only says which
 * column holds the owner on this table.
 */
export function constraintToSql(constraint: RecordConstraint): SQL | undefined {
  return scopeToSql(constraint, sql`${leads.ownerId}`);
}

/** Build one filter predicate. The operator is whitelisted by the contracts layer. */
export function filterToSql(filter: ParsedFilter, fields: readonly FieldDefinition[]): SQL {
  const column = expressionForField(filter.field, fields);
  const operator: FilterOperator = filter.operator;

  switch (operator) {
    case 'eq':
      return sql`${column} = ${filter.value}`;
    case 'neq':
      return sql`${column} is distinct from ${filter.value}`;
    case 'lt':
      return sql`${column} < ${filter.value}`;
    case 'lte':
      return sql`${column} <= ${filter.value}`;
    case 'gt':
      return sql`${column} > ${filter.value}`;
    case 'gte':
      return sql`${column} >= ${filter.value}`;
    case 'contains':
      return sql`${column} ilike ${`%${escapeLikePattern(filter.value)}%`} escape ${LIKE_ESCAPE}`;
    case 'starts_with':
      return sql`${column} ilike ${`${escapeLikePattern(filter.value)}%`} escape ${LIKE_ESCAPE}`;
    case 'in': {
      const values = filter.value.split(',').filter((value) => value.length > 0);
      if (values.length === 0) return sql`false`;
      if (values.length > 100) {
        throw new ValidationError([
          { path: filter.field, message: 'An "in" filter accepts at most 100 values' },
        ]);
      }
      return sql`${column} in (${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )})`;
    }
    case 'is_null':
      return sql`${column} is null`;
    case 'is_not_null':
      return sql`${column} is not null`;
  }
}

/** Free-text search across the fields a person would actually type into a box. */
export function searchToSql(term: string): SQL {
  const pattern = `%${escapeLikePattern(term)}%`;
  return or(
    sql`${leads.firstName} ilike ${pattern} escape ${LIKE_ESCAPE}`,
    sql`${leads.lastName} ilike ${pattern} escape ${LIKE_ESCAPE}`,
    sql`${leads.company} ilike ${pattern} escape ${LIKE_ESCAPE}`,
    sql`${leads.email}::text ilike ${pattern} escape ${LIKE_ESCAPE}`,
    sql`${leads.phone} ilike ${pattern} escape ${LIKE_ESCAPE}`,
  )!;
}

/** Live records only. Soft-deleted rows live in the Recycle Bin (MVP_SPEC M4). */
export function notDeleted(): SQL {
  return isNull(leads.deletedAt);
}

export { and, eq, inArray, sql };
