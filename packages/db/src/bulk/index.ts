import type { BusinessObjectType } from '@crm/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { recordTags, tags } from '../schema/crm.js';

/**
 * Facts and statements the bulk module needs about tables that are not its own
 * (ADR-0056, CLAUDE.md §3).
 *
 * The same arrangement as `access/records.ts` and `access/reassign.ts`: a small closed catalogue in
 * the db package, because the API's module boundaries forbid the bulk module reading the contacts
 * or deals tables and the facts it needs are identical for all four. Table and column names are
 * constants below, quoted with `sql.identifier`, never request values (CLAUDE.md §5.7).
 *
 * Tags are polymorphic (`record_tags.object_type`, ADR-0005), so their statements are written
 * once here rather than once per object module.
 */

const TABLES: Readonly<Record<BusinessObjectType, string>> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
};

export interface BulkRowRef {
  readonly id: string;
  readonly ownerId: string | null;
  readonly version: number;
}

/**
 * The live records among `ids`, with the owner and version each had when this was read.
 *
 * No record scope is applied, deliberately: the caller needs to tell "outside your scope" from
 * "gone", and does so by judging each row against `can()` itself. What this returns is never sent
 * to the client as is.
 */
export async function loadBulkRows(
  tx: Tx,
  tenantId: string,
  objectType: BusinessObjectType,
  ids: readonly string[],
): Promise<Map<string, BulkRowRef>> {
  const rows = new Map<string, BulkRowRef>();
  if (ids.length === 0) return rows;

  const table = sql.identifier(TABLES[objectType]);
  const result = await tx.execute(sql`
    select id, owner_id, version
    from ${table}
    where tenant_id = ${tenantId}::uuid
      and deleted_at is null
      and id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  for (const row of result.rows as unknown as {
    id: string;
    owner_id: string | null;
    version: number;
  }[]) {
    rows.set(row.id, { id: row.id, ownerId: row.owner_id, version: row.version });
  }
  return rows;
}

export interface TagRef {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

/** Every tag in the workspace, by name. The picker's list; bounded by `TAGS_MAX_PER_TENANT`. */
export async function listTags(tx: Tx, tenantId: string): Promise<TagRef[]> {
  const rows = await tx
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(eq(tags.tenantId, tenantId))
    .orderBy(sql`lower(${tags.name})`, tags.id);
  return rows;
}

export async function countTags(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tags)
    .where(eq(tags.tenantId, tenantId));
  return rows[0]?.n ?? 0;
}

/** Tags whose name matches any of `names`, ignoring case: "VIP" and "vip" are one tag. */
export async function findTagsByName(
  tx: Tx,
  tenantId: string,
  names: readonly string[],
): Promise<TagRef[]> {
  if (names.length === 0) return [];
  const lowered = names.map((name) => name.toLowerCase());
  return tx
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(
      and(
        eq(tags.tenantId, tenantId),
        sql`lower(${tags.name}) in (${sql.join(
          lowered.map((name) => sql`${name}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(tags.createdAt, tags.id);
}

/** Insert a tag; if the exact name raced in from another request, return that one. */
export async function insertTag(
  tx: Tx,
  row: { id: string; tenantId: string; name: string; createdBy: string },
): Promise<TagRef> {
  const inserted = await tx
    .insert(tags)
    .values({ ...row, updatedBy: row.createdBy })
    .onConflictDoNothing()
    .returning({ id: tags.id, name: tags.name, color: tags.color });
  const made = inserted[0];
  if (made !== undefined) return made;

  const existing = await tx
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(and(eq(tags.tenantId, row.tenantId), eq(tags.name, row.name)))
    .limit(1);
  const found = existing[0];
  if (found === undefined) throw new Error('A tag that conflicted could not be read back');
  return found;
}

/** Attach tags to one record. Returns the ids of the tags that were **new** to it. */
export async function addRecordTags(
  tx: Tx,
  args: {
    readonly tenantId: string;
    readonly userId: string;
    readonly objectType: BusinessObjectType;
    readonly recordId: string;
    readonly tags: readonly { id: string; rowId: string }[];
  },
): Promise<string[]> {
  if (args.tags.length === 0) return [];
  const inserted = await tx
    .insert(recordTags)
    .values(
      args.tags.map((tag) => ({
        id: tag.rowId,
        tenantId: args.tenantId,
        tagId: tag.id,
        objectType: args.objectType,
        recordId: args.recordId,
        createdBy: args.userId,
        updatedBy: args.userId,
      })),
    )
    .onConflictDoNothing()
    .returning({ tagId: recordTags.tagId });
  return inserted.map((row) => row.tagId);
}

/** Detach tags from one record. Returns the ids of the tags that were on it. */
export async function removeRecordTags(
  tx: Tx,
  args: {
    readonly tenantId: string;
    readonly objectType: BusinessObjectType;
    readonly recordId: string;
    readonly tagIds: readonly string[];
  },
): Promise<string[]> {
  if (args.tagIds.length === 0) return [];
  const removed = await tx
    .delete(recordTags)
    .where(
      and(
        eq(recordTags.tenantId, args.tenantId),
        eq(recordTags.objectType, args.objectType),
        eq(recordTags.recordId, args.recordId),
        inArray(recordTags.tagId, [...args.tagIds]),
      ),
    )
    .returning({ tagId: recordTags.tagId });
  return removed.map((row) => row.tagId);
}
