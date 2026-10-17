import {
  isUuid,
  sortableFieldKeys,
  ValidationError,
  type FieldDefinition,
  type RecordConstraint,
} from '@crm/core';
import type { FilterOperator, ParsedFilter } from '@crm/contracts';
import { accounts, isNull, or, sql, type SQL } from '@crm/db';
import { constraintToSql as scopeToSql } from '../../common/record-scope.js';

/**
 * SQL fragments for the accounts repository.
 *
 * Everything a client can influence — sort key, filter field, filter operator,
 * filter value — is resolved against a whitelist here before it becomes SQL
 * (CLAUDE.md §5.7). Values are always bound parameters; nothing is
 * interpolated into a statement.
 *
 * One thing is done differently from the contacts version it was modelled on:
 * a filter **value** is checked against the column's type before it is bound.
 * Contacts binds every value as text and lets Postgres coerce, which is safe —
 * it is still a parameter — but `created_at:gt:banana` then fails inside the
 * driver as an unhandled error and becomes a 500 rather than a 422. Accounts
 * has four non-text sortable columns, so the same mistake is four times as
 * easy to make here.
 */

/**
 * Escape a user's search term for ILIKE.
 *
 * Deliberately **not** backslash. A backslash escape has to survive a
 * JavaScript template literal, a SQL string literal and Postgres's own LIKE
 * parsing, and getting any one of those wrong fails silently: the pattern
 * still runs, it just stops escaping, so a lone `%` quietly matches every row.
 */
const LIKE_ESCAPE = '!';

export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

/**
 * What kind of value a column holds.
 *
 * Only used to decide which values and operators are acceptable for it — the
 * cast that follows is written out in the predicate, not built from this.
 */
type ColumnKind = 'text' | 'number' | 'uuid' | 'timestamp';

interface StandardColumn {
  readonly expression: SQL;
  readonly kind: ColumnKind;
}

/**
 * Standard columns a caller may sort or filter on, by their API field key.
 *
 * `annual_revenue` maps to the **minor-unit amount**. Sorting by a money
 * column only means anything within one currency, which is a reporting
 * problem the P0 spec does not solve (MVP_SPEC M5 keeps multi-currency totals
 * manual); what it must not do is sort "₹100" above "$1,000,000" by comparing
 * formatted text, which is what sorting a rendered value would do.
 */
const STANDARD_COLUMNS: Readonly<Record<string, StandardColumn>> = {
  name: { expression: sql`${accounts.name}`, kind: 'text' },
  domain: { expression: sql`${accounts.domain}`, kind: 'text' },
  industry: { expression: sql`${accounts.industry}`, kind: 'text' },
  phone: { expression: sql`${accounts.phone}`, kind: 'text' },
  email: { expression: sql`${accounts.email}::text`, kind: 'text' },
  website: { expression: sql`${accounts.website}`, kind: 'text' },
  gstin: { expression: sql`${accounts.gstin}`, kind: 'text' },
  annual_revenue: { expression: sql`${accounts.annualRevenueMinor}`, kind: 'number' },
  employee_count: { expression: sql`${accounts.employeeCount}`, kind: 'number' },
  parent_account_id: { expression: sql`${accounts.parentAccountId}`, kind: 'uuid' },
  owner_id: { expression: sql`${accounts.ownerId}`, kind: 'uuid' },
  created_at: { expression: sql`${accounts.createdAt}`, kind: 'timestamp' },
  updated_at: { expression: sql`${accounts.updatedAt}`, kind: 'timestamp' },
};

function isStandardColumn(key: string): boolean {
  return Object.hasOwn(STANDARD_COLUMNS, key);
}

/**
 * Resolve a client-supplied field key into a SQL expression, or reject it.
 *
 * A key that is neither a standard column nor an **active** field in this
 * tenant's metadata is a 422. Nothing falls through to a default, because a
 * silent fallback is how an unvalidated identifier ends up in a query.
 */
export function resolveField(key: string, fields: readonly FieldDefinition[]): StandardColumn {
  const standard = STANDARD_COLUMNS[key];
  if (standard !== undefined) return standard;

  const custom = fields.find((field) => field.key === key && field.isActive && !field.isSystem);
  if (custom === undefined) {
    throw new ValidationError([{ path: key, message: 'Unknown field' }]);
  }

  // The key is a bound parameter, not string-concatenated into the statement.
  // `->>` yields text whatever the field's declared type, so comparisons on a
  // custom field are text comparisons.
  return { expression: sql`(${accounts.customFields} ->> ${key})`, kind: 'text' };
}

/** The expression alone, for the sort key and the keyset predicate. */
export function expressionForField(key: string, fields: readonly FieldDefinition[]): SQL {
  return resolveField(key, fields).expression;
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
  return scopeToSql(constraint, sql`${accounts.ownerId}`);
}

const NUMERIC = /^-?\d{1,19}$/;
/** A date, or a date and time. Anything looser lets `banana` reach the driver. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Check a filter value against the column it is being compared with.
 *
 * Raises a 422 rather than letting Postgres raise `invalid input syntax`,
 * which arrives as an unmapped driver error and becomes a 500 — an answer
 * that tells the caller nothing and puts a false alarm in the error log.
 */
function assertComparable(field: string, kind: ColumnKind, value: string): void {
  const problem =
    kind === 'number' && !NUMERIC.test(value)
      ? 'Expected a whole number'
      : kind === 'uuid' && !isUuid(value)
        ? 'Expected an id'
        : kind === 'timestamp' && !TIMESTAMP.test(value)
          ? 'Expected a date, as YYYY-MM-DD or an ISO-8601 timestamp'
          : null;

  if (problem !== null) {
    throw new ValidationError([{ path: field, message: problem }]);
  }
}

/** The cast that makes a bound text parameter comparable with the column. */
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
  }
}

/** Build one filter predicate. The operator is whitelisted by the contracts layer. */
export function filterToSql(filter: ParsedFilter, fields: readonly FieldDefinition[]): SQL {
  const { expression, kind } = resolveField(filter.field, fields);
  const operator: FilterOperator = filter.operator;

  const comparable = (): SQL => {
    assertComparable(filter.field, kind, filter.value);
    return cast(kind, filter.value);
  };

  /** Substring matching only makes sense on text; elsewhere it is a mistake. */
  const assertTextual = (): void => {
    if (kind !== 'text') {
      throw new ValidationError([
        { path: filter.field, message: `Cannot use "${operator}" on this field` },
      ]);
    }
  };

  switch (operator) {
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
 * Free-text search across the fields a person would actually type into a box.
 *
 * Name, domain, email and phone — the four ways someone refers to a company
 * they half-remember. GSTIN and website are deliberately out: nobody searches
 * by either, and every column added here costs a scan.
 */
export function searchToSql(term: string): SQL {
  const pattern = `%${escapeLikePattern(term)}%`;
  return or(
    sql`${accounts.name} ilike ${pattern} escape ${LIKE_ESCAPE}`,
    sql`${accounts.domain} ilike ${pattern} escape ${LIKE_ESCAPE}`,
    sql`${accounts.email}::text ilike ${pattern} escape ${LIKE_ESCAPE}`,
    sql`${accounts.phone} ilike ${pattern} escape ${LIKE_ESCAPE}`,
  )!;
}

/** Live records only. Soft-deleted rows live in the Recycle Bin (MVP_SPEC M4). */
export function notDeleted(): SQL {
  return isNull(accounts.deletedAt);
}
