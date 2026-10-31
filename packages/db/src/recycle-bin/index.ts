import {
  isMergeableObjectType,
  SOFT_DELETABLE_OBJECT_TYPES,
  type RecordConstraint,
  type SoftDeletableObjectType,
} from '@crm/core';
import { and, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { markMergeUndone } from '../merge/index.js';
import { constraintToSql } from '../record-scope.js';

/**
 * The Recycle Bin's data access (MVP_SPEC M4).
 *
 * In `@crm/db` rather than in the API because two processes need exactly these
 * statements: the API lists and restores, and the worker's purge job deletes.
 * Writing the second copy in the worker is how "restore" and "purge" end up
 * disagreeing about which rows are in the Bin — the same reasoning that put the
 * search projection and the import descriptors here (ADR-0028, ADR-0029).
 *
 * Every table it touches shares the shape CLAUDE.md §7 gives business records:
 * `id, tenant_id, deleted_at, version`, plus an ownership column that is
 * `assigned_to` on activities and `owner_id` on everything else (ADR-0026).
 * That single difference is the only reason this is a registry rather than one
 * function.
 *
 * **Table names never come from a caller.** They are read out of the registry
 * below, keyed by a validated `SoftDeletableObjectType`, and passed through
 * `sql.identifier`. An object type that arrived from a client is validated
 * against the closed set in `@crm/core` first (CLAUDE.md §5.7).
 */

export interface RecyclableDescriptor {
  readonly objectType: SoftDeletableObjectType;
  readonly table: string;
  /** The column record scope is judged against. */
  readonly ownerColumn: string;
  /**
   * Columns the Bin builds its label from, paired with the `field_definitions`
   * key that governs reading them.
   *
   * Paired rather than assumed equal, because the caller checks each key with
   * `canReadField` before using the value: a reader who cannot see `last_name`
   * must not be shown it in the Bin either, and the Bin falling back to the
   * object's name is a better answer than a leak.
   */
  readonly labelColumns: readonly { readonly fieldKey: string; readonly column: string }[];
}

export const RECYCLABLE_DESCRIPTORS: Readonly<
  Record<SoftDeletableObjectType, RecyclableDescriptor>
> = {
  account: {
    objectType: 'account',
    table: 'accounts',
    ownerColumn: 'owner_id',
    labelColumns: [{ fieldKey: 'name', column: 'name' }],
  },
  contact: {
    objectType: 'contact',
    table: 'contacts',
    ownerColumn: 'owner_id',
    labelColumns: [
      { fieldKey: 'first_name', column: 'first_name' },
      { fieldKey: 'last_name', column: 'last_name' },
    ],
  },
  lead: {
    objectType: 'lead',
    table: 'leads',
    ownerColumn: 'owner_id',
    labelColumns: [
      { fieldKey: 'first_name', column: 'first_name' },
      { fieldKey: 'last_name', column: 'last_name' },
      { fieldKey: 'company', column: 'company' },
    ],
  },
  deal: {
    objectType: 'deal',
    table: 'deals',
    ownerColumn: 'owner_id',
    labelColumns: [{ fieldKey: 'name', column: 'name' }],
  },
  activity: {
    objectType: 'activity',
    table: 'activities',
    // The ownership column, and there is deliberately no owner_id beside it.
    ownerColumn: 'assigned_to',
    labelColumns: [{ fieldKey: 'subject', column: 'subject' }],
  },
};

export function descriptorFor(objectType: SoftDeletableObjectType): RecyclableDescriptor {
  return RECYCLABLE_DESCRIPTORS[objectType];
}

export interface DeletedRecordRow {
  readonly id: string;
  readonly owner_id: string | null;
  readonly deleted_at: Date | string;
  /**
   * `deleted_at` as Postgres renders it, carried verbatim into the cursor.
   *
   * A timestamptz holds microseconds and a JavaScript Date holds milliseconds,
   * so a cursor built from `deleted_at.toISOString()` is *earlier* than the row
   * it came from — and the next page's comparison then skips every row between
   * the two. Rendering it in SQL is the same rule the export pager follows
   * (ADR-0012).
   */
  readonly cursor_value: string;
  readonly version: number;
  /** The label columns, by `field_definitions` key. Filtered by the caller. */
  readonly label_parts: Readonly<Record<string, string | null>>;
}

/**
 * A page of deleted records, most recently deleted first.
 *
 * Keyset on `(deleted_at desc, id desc)`, which is what
 * `<table>_tenant_deleted_idx` (migration 0016) is ordered by — a partial index
 * over the soft-deleted slice only, so this never touches a live row.
 *
 * The record-scope constraint is a WHERE clause, not a post-filter: a rep on
 * `own` scope must not be able to page through a colleague's deleted records,
 * and filtering after the fetch would also break the cursor (ADR-0012).
 */
export async function selectDeletedPage(
  tx: Tx,
  tenantId: string,
  descriptor: RecyclableDescriptor,
  options: {
    readonly constraint: RecordConstraint;
    readonly limit: number;
    readonly cursor: { readonly value: string | null; readonly id: string } | null;
  },
): Promise<DeletedRecordRow[]> {
  const table = sql.identifier(descriptor.table);
  const owner = sql`r.${sql.identifier(descriptor.ownerColumn)}`;

  const where: SQL[] = [sql`r.tenant_id = ${tenantId}::uuid`, sql`r.deleted_at is not null`];

  const scope = constraintToSql(options.constraint, owner);
  if (scope !== undefined) where.push(scope);

  const cursor = options.cursor;
  if (cursor !== null && cursor.value !== null) {
    where.push(sql`(r.deleted_at, r.id) < (${cursor.value}::timestamptz, ${cursor.id}::uuid)`);
  }

  const labels = sql.join(
    descriptor.labelColumns.map(
      (part) => sql`${part.fieldKey}::text, r.${sql.identifier(part.column)}::text`,
    ),
    sql`, `,
  );

  const result = await tx.execute(sql`
    select r.id,
           ${owner} as owner_id,
           r.deleted_at,
           r.deleted_at::text as cursor_value,
           r.version,
           jsonb_build_object(${labels}) as label_parts
    from ${table} r
    where ${and(...where)}
    order by r.deleted_at desc, r.id desc
    limit ${options.limit}
  `);

  return result.rows as unknown as DeletedRecordRow[];
}

/** One deleted record, for the restore path to judge before it acts. */
export async function selectDeletedById(
  tx: Tx,
  tenantId: string,
  descriptor: RecyclableDescriptor,
  id: string,
): Promise<DeletedRecordRow | null> {
  const table = sql.identifier(descriptor.table);
  const owner = sql`r.${sql.identifier(descriptor.ownerColumn)}`;

  const labels = sql.join(
    descriptor.labelColumns.map(
      (part) => sql`${part.fieldKey}::text, r.${sql.identifier(part.column)}::text`,
    ),
    sql`, `,
  );

  const result = await tx.execute(sql`
    select r.id,
           ${owner} as owner_id,
           r.deleted_at,
           r.deleted_at::text as cursor_value,
           r.version,
           jsonb_build_object(${labels}) as label_parts
    from ${table} r
    where r.tenant_id = ${tenantId}::uuid
      and r.id = ${id}::uuid
      and r.deleted_at is not null
    limit 1
  `);

  return (result.rows[0] as unknown as DeletedRecordRow | undefined) ?? null;
}

/**
 * Put a record back, if its version still matches.
 *
 * `version` is bumped like any other write, so a client holding a stale copy of
 * the restored record is told to reload. The guard on `deleted_at is not null`
 * makes a redelivered or double-clicked restore a no-op rather than a second
 * version bump on a live record.
 */
export async function restoreDeleted(
  tx: Tx,
  tenantId: string,
  descriptor: RecyclableDescriptor,
  id: string,
  version: number,
  userId: string | null,
): Promise<{ readonly id: string; readonly version: number } | null> {
  const table = sql.identifier(descriptor.table);

  const result = await tx.execute(sql`
    update ${table}
    set deleted_at = null,
        version = version + 1,
        updated_at = now(),
        updated_by = ${userId}
    where tenant_id = ${tenantId}::uuid
      and id = ${id}::uuid
      and deleted_at is not null
      and version = ${version}
    returning id, version
  `);

  const restored =
    (result.rows[0] as unknown as { id: string; version: number } | undefined) ?? null;

  // A contact or account that was merged away and is restored is a record again: its old id stops
  // answering "merged into ..." (ADR-0064). Whatever moved to the surviving record stays there.
  if (restored !== null && isMergeableObjectType(descriptor.objectType)) {
    await markMergeUndone(tx, tenantId, descriptor.objectType, id, userId);
  }
  return restored;
}

/**
 * Ids past the retention cutoff, locked for this transaction.
 *
 * `FOR UPDATE SKIP LOCKED` so two purge passes — a redelivery, or two worker
 * processes — never fight over the same rows, and so a record a user is
 * restoring right now is skipped rather than deleted from under them.
 */
export async function selectPurgeable(
  tx: Tx,
  tenantId: string,
  descriptor: RecyclableDescriptor,
  /** A timestamp as Postgres rendered it; cast back in SQL so no precision is lost. */
  cutoff: string,
  limit: number,
): Promise<string[]> {
  const table = sql.identifier(descriptor.table);

  const result = await tx.execute(sql`
    select id
    from ${table}
    where tenant_id = ${tenantId}::uuid
      and deleted_at is not null
      and deleted_at < ${cutoff}::timestamptz
    order by deleted_at
    limit ${limit}
    for update skip locked
  `);

  return (result.rows as unknown as { id: string }[]).map((row) => row.id);
}

/**
 * Delete the record rows themselves.
 *
 * Only the rows; everything that *points* at them is cleaned up by the handlers
 * subscribed to the delete event (ADR-0005), which already do the right thing
 * for a record that is really gone. The guard repeats `deleted_at is not null`
 * so that a bug upstream cannot turn the purge into a way to delete live data.
 */
export async function hardDelete(
  tx: Tx,
  tenantId: string,
  descriptor: RecyclableDescriptor,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const table = sql.identifier(descriptor.table);

  const result = await tx.execute(sql`
    delete from ${table}
    where tenant_id = ${tenantId}::uuid
      and deleted_at is not null
      and id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);

  return result.rowCount ?? 0;
}

/** Every descriptor, in a stable order, for the purge sweep to walk. */
export function allRecyclableDescriptors(): readonly RecyclableDescriptor[] {
  return SOFT_DELETABLE_OBJECT_TYPES.map((objectType) => RECYCLABLE_DESCRIPTORS[objectType]);
}

/**
 * Tables holding rows that point at a record by `(object_type, record_id)`
 * (ADR-0005).
 *
 * ADR-0005 bought cheap new object types by giving up the foreign key on this
 * side, and said the price is that cleanup becomes a job's responsibility. This
 * list is that price, written down in one place. A new polymorphic table adds
 * one line here, and the meta test in `recycle-bin.purge.spec.ts` fails if a
 * table in the schema carries the pair and is missing from it.
 *
 * Tables that reference a record by a plain **foreign key** are deliberately
 * absent: `deal_contacts` and `activity_links.activity_id` both cascade in the
 * database (migrations 0008 and 0010), so the delete below takes them with it.
 * The pair is only needed where ADR-0005 gave the key up.
 */
export const POLYMORPHIC_REFERENCE_TABLE_LIST = [
  'activity_links',
  'record_tags',
  'timeline_events',
  'record_views',
  // The emails on a record (ADR-0073). A message whose every link is purged is deleted too, below.
  'email_message_links',
  // Which records began as sample data (ADR-0037). A purged record's registration
  // goes with it; the registry has no foreign key to its target (ADR-0005).
  'sample_records',
] as const;

/**
 * Remove rows that point at records which are about to stop existing.
 *
 * Deliberately **before** the records are deleted and in the same transaction,
 * so there is no window in which a link points at nothing. Deleting rows that
 * are already gone deletes nothing, which is what makes it idempotent.
 */
export async function removeReferences(
  tx: Tx,
  tenantId: string,
  objectType: SoftDeletableObjectType,
  ids: readonly string[],
): Promise<void> {
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // An email linked only to records that are being purged has nothing left to be shown on, so it goes
  // too (its links follow by cascade). One that is also linked to a record that stays is kept (ADR-0073).
  await tx.execute(sql`
    delete from email_messages m
    where m.tenant_id = ${tenantId}::uuid
      and m.id in (
        select email_message_id from email_message_links
        where tenant_id = ${tenantId}::uuid
          and object_type = ${objectType}
          and record_id in (${idList})
      )
      and not exists (
        select 1 from email_message_links o
        where o.tenant_id = m.tenant_id
          and o.email_message_id = m.id
          and not (o.object_type = ${objectType} and o.record_id in (${idList}))
      )
  `);

  for (const table of POLYMORPHIC_REFERENCE_TABLE_LIST) {
    await tx.execute(sql`
      delete from ${sql.identifier(table)}
      where tenant_id = ${tenantId}::uuid
        and object_type = ${objectType}
        and record_id in (${idList})
    `);
  }

  // The search index is keyed the same way but is a projection rather than a
  // reference, and the soft delete already removed these rows. Repeated here so
  // that a record purged after an index rebuild, or after a failed delete event,
  // does not stay findable — the one case where a stale index row would survive
  // everything else.
  await tx.execute(sql`
    delete from search_documents
    where tenant_id = ${tenantId}::uuid
      and object_type = ${objectType}
      and record_id in (${idList})
  `);
}
