import {
  isUuid,
  sortableFieldKeys,
  ValidationError,
  type FieldDefinition,
  type RecordConstraint,
} from '@crm/core';
import type { FilterOperator, ParsedFilter } from '@crm/contracts';
import { deals, isNull, sql, type SQL } from '@crm/db';
import { constraintToSql as scopeToSql } from '../../common/record-scope.js';

/**
 * SQL fragments for the deals repository.
 *
 * Everything a client can influence — sort key, filter field, filter operator,
 * filter value — is resolved against a whitelist here before it becomes SQL
 * (CLAUDE.md §5.7). Values are always bound parameters; nothing is
 * interpolated into a statement. A filter **value** is checked against the
 * column's type first, so `expected_close_date:gt:banana` is a 422 rather than
 * a driver error surfacing as a 500 (as in accounts).
 */

/** Escape a search term for ILIKE. `!`, not backslash: see contacts for why. */
const LIKE_ESCAPE = '!';

export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE}${character}`);
}

type ColumnKind = 'text' | 'number' | 'uuid' | 'timestamp' | 'date';

interface StandardColumn {
  readonly expression: SQL;
  readonly kind: ColumnKind;
}

/**
 * Standard columns a caller may sort or filter on, by their API field key.
 *
 * Each key is also the **field-permission key** that `assertSortable` and
 * `assertFiltersReadable` check, so the two have to agree: `amount` is the
 * permission that hides the amount, and it is the key that sorts by it.
 * `currency` is deliberately not here. It is half of `amount`, and a
 * permission on `amount` has to hide both halves; a filter on `currency` would
 * be a way to learn which currency a hidden amount is in.
 *
 * `amount` sorts the **minor-unit number**, which only means something within
 * one currency. Sorting across currencies by converted value needs rates inside
 * the query and is a reporting problem for P1; what it must not do is compare
 * rendered text.
 */
const STANDARD_COLUMNS: Readonly<Record<string, StandardColumn>> = {
  name: { expression: sql`${deals.name}`, kind: 'text' },
  amount: { expression: sql`${deals.amountMinor}`, kind: 'number' },
  probability: { expression: sql`${deals.probability}`, kind: 'number' },
  expected_close_date: { expression: sql`${deals.expectedCloseDate}`, kind: 'date' },
  closed_at: { expression: sql`${deals.closedAt}`, kind: 'timestamp' },
  lost_reason: { expression: sql`${deals.lostReason}`, kind: 'text' },
  account_id: { expression: sql`${deals.accountId}`, kind: 'uuid' },
  primary_contact_id: { expression: sql`${deals.primaryContactId}`, kind: 'uuid' },
  pipeline_id: { expression: sql`${deals.pipelineId}`, kind: 'uuid' },
  stage_id: { expression: sql`${deals.stageId}`, kind: 'uuid' },
  owner_id: { expression: sql`${deals.ownerId}`, kind: 'uuid' },
  created_at: { expression: sql`${deals.createdAt}`, kind: 'timestamp' },
  updated_at: { expression: sql`${deals.updatedAt}`, kind: 'timestamp' },
};

function isStandardColumn(key: string): boolean {
  return Object.hasOwn(STANDARD_COLUMNS, key);
}

/**
 * Resolve a client-supplied field key into a SQL expression, or reject it.
 *
 * A key that is neither a standard column nor an **active** field in this
 * tenant's metadata is a 422. Nothing falls through to a default.
 */
export function resolveField(key: string, fields: readonly FieldDefinition[]): StandardColumn {
  const standard = STANDARD_COLUMNS[key];
  if (standard !== undefined) return standard;

  const custom = fields.find((field) => field.key === key && field.isActive && !field.isSystem);
  if (custom === undefined) {
    throw new ValidationError([{ path: key, message: 'Unknown field' }]);
  }

  // The key is a bound parameter, not string-concatenated into the statement.
  return { expression: sql`(${deals.customFields} ->> ${key})`, kind: 'text' };
}

export function expressionForField(key: string, fields: readonly FieldDefinition[]): SQL {
  return resolveField(key, fields).expression;
}

/** The keys a caller may sort by: standard columns plus sortable custom fields. */
export function allowedSortKeys(fields: readonly FieldDefinition[]): string[] {
  const custom = sortableFieldKeys(fields).filter((key) => !isStandardColumn(key));
  return [...Object.keys(STANDARD_COLUMNS), ...custom];
}

/** The actor's record scope as a WHERE clause (ADR-0008). */
export function constraintToSql(constraint: RecordConstraint): SQL | undefined {
  return scopeToSql(constraint, sql`${deals.ownerId}`);
}

const NUMERIC = /^-?\d{1,19}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Raise a 422 rather than let Postgres raise `invalid input syntax` as a 500. */
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

  if (problem !== null) {
    throw new ValidationError([{ path: field, message: problem }]);
  }
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

/** Build one filter predicate. The operator is whitelisted by the contracts layer. */
export function filterToSql(filter: ParsedFilter, fields: readonly FieldDefinition[]): SQL {
  const { expression, kind } = resolveField(filter.field, fields);
  const operator: FilterOperator = filter.operator;

  const comparable = (): SQL => {
    assertComparable(filter.field, kind, filter.value);
    return cast(kind, filter.value);
  };

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

/** Free-text search: a deal is found by what it is called. */
/** Live records only. Soft-deleted rows live in the Recycle Bin (MVP_SPEC M4). */
export function notDeleted(): SQL {
  return isNull(deals.deletedAt);
}
