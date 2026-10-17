import { sql, type SQL } from '@crm/db';
import type { SortDirection } from '@crm/contracts';
import type { Cursor } from './cursor.js';

/**
 * The keyset predicate: "strictly after this (sortValue, id)" (ADR-0012).
 *
 * Shared by every list endpoint, because it is short, subtle, and wrong in two
 * ways that neither a type checker nor a casual read will catch.
 *
 * **It must be parenthesised as a whole.** Drizzle's `and()` joins its operands
 * with ` and ` and parenthesises only the result, not each operand. A fragment
 * containing a bare `or` therefore escapes to the top level of the WHERE
 * clause: `tenant = x and owner = me and (keyset...) or value is not null`
 * parses as `(everything) OR (value is not null)`, and the record-scope
 * predicate stops applying. RLS still holds the tenant boundary, so this is
 * not a cross-tenant leak — but inside a tenant it hands a rep on `own` scope
 * every colleague's records, on the second page of a list sorted by a nullable
 * column. The outer `sql`(...)`` here is the whole defence.
 *
 * **NULLs have a side.** Postgres orders NULLs last for ASC and first for
 * DESC, and `NULL > 'x'` is NULL rather than false, so a row-comparison alone
 * silently drops every null row. Which half needs saying explicitly therefore
 * depends on the direction:
 *
 *   ASC   non-null rows, then the null tail — so "after a non-null value"
 *         must also admit the nulls still to come.
 *   DESC  the null head, then non-null rows — so "after a null" must also
 *         admit the non-nulls still to come.
 *
 * Get it backwards and the list either loses rows or, worse, serves the first
 * page again forever: the caller's cursor never advances and an infinite
 * scroll never ends.
 */
export function keysetPredicate(
  sortExpression: SQL,
  idColumn: SQL,
  direction: SortDirection,
  cursor: Cursor,
): SQL {
  if (direction === 'asc') {
    return cursor.value === null
      ? // Already inside the null tail; only the id breaks the tie.
        sql`(${sortExpression} is null and ${idColumn} > ${cursor.id}::uuid)`
      : sql`((${sortExpression}, ${idColumn}) > (${cursor.value}, ${cursor.id}::uuid)
             or ${sortExpression} is null)`;
  }

  return cursor.value === null
    ? // Still inside the null head; the non-null rows all come after it.
      sql`((${sortExpression} is null and ${idColumn} < ${cursor.id}::uuid)
           or ${sortExpression} is not null)`
    : // Past the null head already, so nulls must not be readmitted.
      sql`((${sortExpression}, ${idColumn}) < (${cursor.value}, ${cursor.id}::uuid))`;
}
