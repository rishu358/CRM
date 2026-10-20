import type { RecordConstraint } from '@crm/core';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { constraintToSql } from '../record-scope.js';

/**
 * Read-only facts about who owns what, for the access explainer (ADR-0031).
 *
 * The explainer has to answer questions that cross every object type — "how
 * many contacts does this change put out of reach", "who owns this record" —
 * and the API's module boundaries (CLAUDE.md §3) forbid one module reading
 * another's tables. This is the same arrangement the search index has
 * (ADR-0028): a small, closed, **read-only** catalogue in the db package that
 * knows exactly one thing about each owner-bearing table — the name of its
 * owner column — and translates a `RecordConstraint` into SQL with the same
 * `constraintToSql` every repository uses.
 *
 * Nothing here writes. Reassignment goes through each module's own service
 * (see `apps/api/src/common/ownership.ts`), because changing an owner must be
 * audited, versioned and announced the way every other edit to that record is.
 *
 * Identifiers come from the closed map below and are quoted with
 * `sql.identifier`; no request value is ever interpolated into a name
 * (CLAUDE.md §5.7).
 */

export const OWNED_OBJECT_TYPES = ['account', 'contact', 'lead', 'deal', 'activity'] as const;
export type OwnedObjectType = (typeof OWNED_OBJECT_TYPES)[number];

export function isOwnedObjectType(value: unknown): value is OwnedObjectType {
  return typeof value === 'string' && (OWNED_OBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * Where each object keeps its owner. An activity's is `assigned_to`
 * (ADR-0026): the assignee is the owner, and there is deliberately no second
 * column that could disagree with it.
 */
const CATALOGUE: Readonly<Record<OwnedObjectType, { table: string; ownerColumn: string }>> = {
  account: { table: 'accounts', ownerColumn: 'owner_id' },
  contact: { table: 'contacts', ownerColumn: 'owner_id' },
  lead: { table: 'leads', ownerColumn: 'owner_id' },
  deal: { table: 'deals', ownerColumn: 'owner_id' },
  activity: { table: 'activities', ownerColumn: 'assigned_to' },
};

function tableOf(objectType: OwnedObjectType) {
  const entry = CATALOGUE[objectType];
  return {
    table: sql.identifier(entry.table),
    owner: sql`${sql.identifier(entry.table)}.${sql.identifier(entry.ownerColumn)}`,
  };
}

export interface OwnedRecordRef {
  readonly id: string;
  readonly ownerId: string | null;
}

/**
 * The owner of one live record, or `null` when it does not exist.
 *
 * `null` is also what a record in another tenant looks like: the tenant
 * filter is explicit here and RLS backs it, so there is no id this can be used
 * to probe across tenants.
 */
export async function findOwnedRecord(
  tx: Tx,
  tenantId: string,
  objectType: OwnedObjectType,
  id: string,
): Promise<OwnedRecordRef | null> {
  const { table, owner } = tableOf(objectType);
  const result = await tx.execute(sql`
    select ${table}.id as id, ${owner} as owner_id
    from ${table}
    where ${table}.tenant_id = ${tenantId}
      and ${table}.id = ${id}::uuid
      and ${table}.deleted_at is null
    limit 1
  `);
  const row = (result.rows as unknown as { id: string; owner_id: string | null }[])[0];
  return row === undefined ? null : { id: row.id, ownerId: row.owner_id };
}

/**
 * How many live records a constraint reaches.
 *
 * Takes the constraint `can()` returned, so the number is the size of the list
 * that actor's list endpoint would page through — the repositories put the
 * same `constraintToSql` in their WHERE clause. A test holds the two to each
 * other (`access.parity.security.spec.ts`).
 */
export async function countOwnedRecords(
  tx: Tx,
  tenantId: string,
  objectType: OwnedObjectType,
  constraint: RecordConstraint,
): Promise<number> {
  const { table, owner } = tableOf(objectType);
  const scope = constraintToSql(constraint, owner);
  const result = await tx.execute(sql`
    select count(*)::int as n
    from ${table}
    where ${table}.tenant_id = ${tenantId}
      and ${table}.deleted_at is null
      ${scope === undefined ? sql`` : sql`and (${scope})`}
  `);
  return (result.rows as unknown as { n: number }[])[0]?.n ?? 0;
}

/** Live records of each owned type that a user owns — for "who owns what". */
export async function countRecordsOwnedBy(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<Record<OwnedObjectType, number>> {
  const counts = {} as Record<OwnedObjectType, number>;
  for (const objectType of OWNED_OBJECT_TYPES) {
    counts[objectType] = await countOwnedRecords(tx, tenantId, objectType, {
      kind: 'own',
      userId: userId as never,
    });
  }
  return counts;
}

/**
 * The teams each of these users belongs to.
 *
 * Needed to judge a record under `team` scope in memory: a record has no team
 * column, its "team" is whichever teams its owner is in (see `constraintToSql`).
 */
export async function teamIdsByUser(
  tx: Tx,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (userIds.length === 0) return map;

  const result = await tx.execute(sql`
    select user_id, team_id
    from team_members
    where tenant_id = ${tenantId}
      and user_id in (${sql.join(
        userIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  for (const row of result.rows as unknown as { user_id: string; team_id: string }[]) {
    const list = map.get(row.user_id) ?? [];
    list.push(row.team_id);
    map.set(row.user_id, list);
  }
  return map;
}
