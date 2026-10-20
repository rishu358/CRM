import type { RecordConstraint } from '@crm/core';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { constraintToSql } from '../record-scope.js';

/**
 * Move records to a new owner (MVP_SPEC M3).
 *
 * One statement, written once, called by each module for **its own** table.
 * The table and column names are supplied by the owning module's code — they
 * are constants in that module, never request values — and are quoted with
 * `sql.identifier` (CLAUDE.md §5.7). Nothing in this file knows the name of any
 * table, so adding an owned object does not touch it.
 *
 * What it guarantees, and why each matters:
 *
 *  - **Only live records the actor may update.** The `constraint` is what
 *    `can(actor, 'update')` returned, translated by the same `constraintToSql`
 *    every repository uses. A record outside it is not "denied": it simply is
 *    not selected, so the caller cannot tell it from one that does not exist
 *    (CLAUDE.md §5.5).
 *  - **Rows are locked before they are changed** (`FOR UPDATE`), so the previous
 *    owner reported for the audit entry is the one that was actually replaced,
 *    even when somebody edits the record at the same moment.
 *  - **`version` moves**, as for any edit, so a form open on the record learns
 *    it is stale (409) rather than overwriting the reassignment.
 *  - **Already-theirs records are left alone.** No version bump, no audit entry,
 *    no event for a change that is not a change.
 *  - **Bounded.** `limit` caps one call; the caller loops while `remaining`.
 */
export interface OwnedTable {
  /** The owning module's table. A constant in that module's code. */
  readonly table: string;
  /** `owner_id` for most; `assigned_to` for activities (ADR-0026). */
  readonly ownerColumn: string;
}

export interface ReassignedRow {
  readonly id: string;
  readonly previousOwnerId: string | null;
  readonly version: number;
}

export type ReassignSelector =
  { readonly ids: readonly string[] } | { readonly fromOwnerId: string };

export async function reassignOwned(
  tx: Tx,
  spec: OwnedTable,
  args: {
    readonly tenantId: string;
    readonly updatedBy: string;
    readonly toOwnerId: string;
    readonly constraint: RecordConstraint;
    readonly selector: ReassignSelector;
    readonly limit: number;
  },
): Promise<ReassignedRow[]> {
  const table = sql.identifier(spec.table);
  const column = sql.identifier(spec.ownerColumn);
  const owner = sql`${table}.${column}`;

  const scope = constraintToSql(args.constraint, owner);
  const selection =
    'ids' in args.selector
      ? sql`${table}.id in (${sql.join(
          args.selector.ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql`${owner} = ${args.selector.fromOwnerId}::uuid`;

  const result = await tx.execute(sql`
    with target as (
      select ${table}.id as id, ${owner} as previous_owner
      from ${table}
      where ${table}.tenant_id = ${args.tenantId}::uuid
        and ${table}.deleted_at is null
        and ${owner} is distinct from ${args.toOwnerId}::uuid
        and ${selection}
        ${scope === undefined ? sql`` : sql`and (${scope})`}
      order by ${table}.id
      limit ${args.limit}
      for update
    )
    update ${table} as t
    set ${column} = ${args.toOwnerId}::uuid,
        updated_by = ${args.updatedBy}::uuid,
        updated_at = now(),
        version = t.version + 1
    from target
    where t.id = target.id
    returning t.id as id, target.previous_owner as previous_owner, t.version as version
  `);

  return (
    result.rows as unknown as { id: string; previous_owner: string | null; version: number }[]
  ).map((row) => ({ id: row.id, previousOwnerId: row.previous_owner, version: row.version }));
}

/**
 * How many records a selector would still match for this actor — the
 * `remaining` a bulk call reports after it has handled one batch.
 */
export async function countReassignable(
  tx: Tx,
  spec: OwnedTable,
  args: {
    readonly tenantId: string;
    readonly toOwnerId: string;
    readonly constraint: RecordConstraint;
    readonly fromOwnerId: string;
  },
): Promise<number> {
  const table = sql.identifier(spec.table);
  const owner = sql`${table}.${sql.identifier(spec.ownerColumn)}`;
  const scope = constraintToSql(args.constraint, owner);
  const result = await tx.execute(sql`
    select count(*)::int as n
    from ${table}
    where ${table}.tenant_id = ${args.tenantId}::uuid
      and ${table}.deleted_at is null
      and ${owner} is distinct from ${args.toOwnerId}::uuid
      and ${owner} = ${args.fromOwnerId}::uuid
      ${scope === undefined ? sql`` : sql`and (${scope})`}
  `);
  return (result.rows as unknown as { n: number }[])[0]?.n ?? 0;
}
