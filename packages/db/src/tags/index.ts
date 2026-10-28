import {
  TAG_FILTER_MAX_IDS,
  ValidationError,
  isUuid,
  type BusinessObjectType,
  type TagColor,
} from '@crm/core';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { recordTags, tags } from '../schema/crm.js';

/**
 * What tags need from the database beyond the bulk module's add and remove (ADR-0063).
 *
 * In `@crm/db`, with the same reasoning as `bulk/index.ts`: the contact, account, lead and deal
 * modules each need "the tags on these records" and "filter by tag", and the module boundary says
 * none of them may read `record_tags` directly. Written once here, the filter is the same statement
 * in all four lists, in an export and in a saved view.
 */

export interface RecordTagRef {
  readonly id: string;
  readonly name: string;
  readonly color: TagColor | null;
}

/**
 * The tags on each of `ids`, by name, as the chips a record page and a list row show.
 *
 * One query for the whole page, never one per row. Callers pass only ids they already loaded under
 * the reader's record scope, so a tag is never reported for a record the reader cannot see.
 */
export async function tagsForRecords(
  tx: Tx,
  tenantId: string,
  objectType: BusinessObjectType,
  ids: readonly string[],
): Promise<Map<string, RecordTagRef[]>> {
  const byRecord = new Map<string, RecordTagRef[]>();
  if (ids.length === 0) return byRecord;

  const rows = await tx
    .select({
      recordId: recordTags.recordId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(recordTags)
    .innerJoin(tags, and(eq(tags.tenantId, recordTags.tenantId), eq(tags.id, recordTags.tagId)))
    .where(
      and(
        eq(recordTags.tenantId, tenantId),
        eq(recordTags.objectType, objectType),
        inArray(recordTags.recordId, [...ids]),
      ),
    )
    .orderBy(sql`lower(${tags.name})`, tags.id);

  for (const row of rows) {
    const list = byRecord.get(row.recordId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    byRecord.set(row.recordId, list);
  }
  return byRecord;
}

/**
 * The predicate for `tags:has_any:<ids>` and `tags:has_none:<ids>`.
 *
 * An `exists` over `record_tags`, correlated to the row by id and tenant, so it composes with the
 * list's other predicates, its keyset cursor and its record scope, and can only ever narrow what the
 * scope already allows. Tag ids are validated as uuids here and bound as parameters; nothing a
 * client sent becomes SQL text (CLAUDE.md §5.7). Whether the ids name real tags does not matter and
 * is not revealed: an id that names nothing matches no record, so `has_any` of it is an empty list
 * and `has_none` of it is every record.
 */
export function tagFilterSql(args: {
  readonly field: string;
  readonly objectType: BusinessObjectType;
  readonly operator: 'has_any' | 'has_none';
  readonly value: string;
  readonly idColumn: SQL;
  readonly tenantColumn: SQL;
}): SQL {
  const ids = [...new Set(args.value.split(',').filter((id) => id.length > 0))];
  if (ids.length === 0) {
    throw new ValidationError([{ path: args.field, message: 'Choose at least one tag' }]);
  }
  if (ids.length > TAG_FILTER_MAX_IDS) {
    throw new ValidationError([
      { path: args.field, message: `A tag filter accepts at most ${TAG_FILTER_MAX_IDS} tags` },
    ]);
  }
  if (!ids.every((id) => isUuid(id))) {
    throw new ValidationError([{ path: args.field, message: 'Expected tag ids' }]);
  }

  const tagIds = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const matching = sql`exists (
    select 1 from record_tags rt
    where rt.tenant_id = ${args.tenantColumn}
      and rt.object_type = ${args.objectType}
      and rt.record_id = ${args.idColumn}
      and rt.tag_id in (${tagIds})
  )`;
  return args.operator === 'has_any' ? matching : sql`not ${matching}`;
}

/** Narrow a filter's operator to a tag operator; the check every list makes before it asks for the tag SQL. */
export function isTagFilterOperator(operator: string): operator is 'has_any' | 'has_none' {
  return operator === 'has_any' || operator === 'has_none';
}

export interface TagUsageRow {
  readonly id: string;
  readonly name: string;
  readonly color: TagColor | null;
  readonly version: number;
  readonly records: Readonly<Record<BusinessObjectType, number>>;
}

/**
 * Every tag with how many **live** records of each kind carry it.
 *
 * Counts every record in the workspace, not only those the caller may read, which is why the API
 * offers it only to somebody who manages tags (`update` on `tenant_settings`): the number of
 * records carrying a tag is an aggregate about records the caller may not be able to see.
 */
export async function listTagUsage(tx: Tx, tenantId: string): Promise<TagUsageRow[]> {
  const result = await tx.execute(sql`
    select t.id, t.name, t.color, t.version,
           coalesce(c.contact, 0)::int as contact,
           coalesce(c.account, 0)::int as account,
           coalesce(c.lead, 0)::int as lead,
           coalesce(c.deal, 0)::int as deal
    from tags t
    left join (
      select rt.tag_id,
             count(*) filter (where rt.object_type = 'contact' and ct.id is not null) as contact,
             count(*) filter (where rt.object_type = 'account' and ac.id is not null) as account,
             count(*) filter (where rt.object_type = 'lead' and ld.id is not null) as lead,
             count(*) filter (where rt.object_type = 'deal' and dl.id is not null) as deal
      from record_tags rt
      left join contacts ct on rt.object_type = 'contact' and ct.tenant_id = rt.tenant_id
                           and ct.id = rt.record_id and ct.deleted_at is null
      left join accounts ac on rt.object_type = 'account' and ac.tenant_id = rt.tenant_id
                           and ac.id = rt.record_id and ac.deleted_at is null
      left join leads ld on rt.object_type = 'lead' and ld.tenant_id = rt.tenant_id
                        and ld.id = rt.record_id and ld.deleted_at is null
      left join deals dl on rt.object_type = 'deal' and dl.tenant_id = rt.tenant_id
                        and dl.id = rt.record_id and dl.deleted_at is null
      where rt.tenant_id = ${tenantId}::uuid
      group by rt.tag_id
    ) c on c.tag_id = t.id
    where t.tenant_id = ${tenantId}::uuid
    order by lower(t.name), t.id
  `);
  return (
    result.rows as unknown as {
      id: string;
      name: string;
      color: TagColor | null;
      version: number;
      contact: number;
      account: number;
      lead: number;
      deal: number;
    }[]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    version: row.version,
    records: { contact: row.contact, account: row.account, lead: row.lead, deal: row.deal },
  }));
}

export async function findTagById(tx: Tx, tenantId: string, id: string) {
  const rows = await tx
    .select({ id: tags.id, name: tags.name, color: tags.color, version: tags.version })
    .from(tags)
    .where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/** Another tag whose name matches `name` ignoring case, for the rename collision check. */
export async function findOtherTagByName(
  tx: Tx,
  tenantId: string,
  name: string,
  exceptId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(
      and(
        eq(tags.tenantId, tenantId),
        sql`lower(${tags.name}) = ${name.toLowerCase()}`,
        sql`${tags.id} <> ${exceptId}::uuid`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Rename or recolour at a version; `null` means the version moved (or the tag is gone). */
export async function updateTagWithVersion(
  tx: Tx,
  args: {
    readonly tenantId: string;
    readonly id: string;
    readonly version: number;
    readonly userId: string;
    readonly patch: { readonly name?: string; readonly color?: TagColor | null };
  },
) {
  const rows = await tx
    .update(tags)
    .set({
      ...(args.patch.name === undefined ? {} : { name: args.patch.name }),
      ...(args.patch.color === undefined ? {} : { color: args.patch.color }),
      version: sql`${tags.version} + 1`,
      updatedAt: sql`now()`,
      updatedBy: args.userId,
    })
    .where(
      and(eq(tags.tenantId, args.tenantId), eq(tags.id, args.id), eq(tags.version, args.version)),
    )
    .returning({ id: tags.id, name: tags.name, color: tags.color, version: tags.version });
  return rows[0] ?? null;
}

/**
 * Delete a tag at a version. Its `record_tags` rows go with it (the foreign key cascades), which is
 * the point: a deleted tag leaves no chip behind on any record.
 */
export async function deleteTagWithVersion(
  tx: Tx,
  args: { readonly tenantId: string; readonly id: string; readonly version: number },
): Promise<boolean> {
  const rows = await tx
    .delete(tags)
    .where(
      and(eq(tags.tenantId, args.tenantId), eq(tags.id, args.id), eq(tags.version, args.version)),
    )
    .returning({ id: tags.id });
  return rows.length > 0;
}
