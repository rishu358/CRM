import { ValidationError, type FieldDefinition, type RecordConstraint } from '@crm/core';
import { sortableFieldKeys } from '@crm/core';
import type { FilterOperator, ParsedFilter } from '@crm/contracts';
import { activities, and, eq, inArray, isNull, or, sql, type SQL } from '@crm/db';
import { constraintToSql as scopeToSql } from '../../common/record-scope.js';

/**
 * SQL fragments for the activities repository.
 *
 * Everything a client can influence — sort key, filter field, filter operator,
 * the `object_type` of a link — is resolved against a whitelist before it
 * becomes SQL (CLAUDE.md §5.7). Values are always bound parameters; nothing is
 * interpolated into a statement.
 */

/** See the note in `contacts.sql-helpers.ts`: `!` keeps this backslash-free. */
const LIKE_ESCAPE = '!';

export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

/** Standard columns a caller may sort or filter on, by their API field key. */
const STANDARD_COLUMNS = {
  type: activities.type,
  subject: activities.subject,
  body: activities.body,
  due_at: activities.dueAt,
  completed_at: activities.completedAt,
  priority: activities.priority,
  status: activities.status,
  assigned_to: activities.assignedTo,
  created_at: activities.createdAt,
  updated_at: activities.updatedAt,
} as const;

type StandardColumnKey = keyof typeof STANDARD_COLUMNS;

function isStandardColumn(key: string): key is StandardColumnKey {
  return Object.hasOwn(STANDARD_COLUMNS, key);
}

/**
 * Resolve a client-supplied field key into a SQL expression, or reject it.
 *
 * A key that is neither a standard column nor an **active** field in this
 * tenant's metadata is a 422. Nothing falls through to a default.
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
  return sql`(${activities.customFields} ->> ${key})`;
}

/** The keys a caller may sort by: standard columns plus sortable custom fields. */
export function allowedSortKeys(fields: readonly FieldDefinition[]): string[] {
  const custom = sortableFieldKeys(fields).filter((key) => !isStandardColumn(key));
  return [...Object.keys(STANDARD_COLUMNS), ...custom];
}

/**
 * The actor's record scope as a WHERE clause (ADR-0008).
 *
 * `assigned_to` is the ownership column on this table — there is no
 * `owner_id` (ADR-0026) — so this is where that decision becomes real: a rep
 * with `own` scope sees the activities assigned to them, and a manager with
 * `team` scope sees their team's.
 */
export function constraintToSql(constraint: RecordConstraint): SQL | undefined {
  return scopeToSql(constraint, sql`${activities.assignedTo}`);
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

/**
 * Free-text search.
 *
 * Over the subject only, not the body: the body is HTML, so a search for
 * "strong" would match every bolded note, and matching inside markup is both
 * wrong and slow. A proper body search belongs to the search provider
 * (MVP_SPEC M7), which indexes the extracted text.
 */
/**
 * The columns a free-text search may look in, by field key.
 *
 * What a caller may search is what they may read (CLAUDE.md §5.4). Matching a column is a read of
 * it: `q=@gmail` answered as a list of rows is a character-at-a-time read of a hidden value, the
 * same side channel `sort` and `filter` close in `common/field-queries.ts`.
 */
const SEARCH_COLUMNS: Readonly<Record<string, SQL>> = {
  subject: sql`${activities.subject}`,
};

/** The keys `searchToSql` knows, for the service to intersect with what the actor may read. */
export const SEARCH_FIELD_KEYS: readonly string[] = Object.keys(SEARCH_COLUMNS);

/**
 * Free-text search over `readable` columns only. With none readable the predicate is false: a
 * caller who may read none of them is told there are no matches, as if there were none.
 */
export function searchToSql(term: string, readable: readonly string[]): SQL {
  const pattern = `%${escapeLikePattern(term)}%`;
  const parts = readable.map((key) => {
    const column = SEARCH_COLUMNS[key];
    return column === undefined ? undefined : sql`${column} ilike ${pattern} escape ${LIKE_ESCAPE}`;
  });
  return or(...parts) ?? sql`false`;
}

/** Live records only. Soft-deleted rows live in the Recycle Bin. */
export function notDeleted(): SQL {
  return isNull(activities.deletedAt);
}

export { and, eq, inArray, sql };
