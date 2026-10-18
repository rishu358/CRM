import {
  SEARCHABLE_FIELDS,
  type SearchDocument,
  type SearchDocumentField,
  type SearchableObjectType,
  type Uuid,
} from '@crm/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { accounts, activities, contacts, deals, leads } from '../schema/crm.js';

/**
 * How a record becomes a search document (ADR-0028 §3).
 *
 * The one projection. The outbox relay calls it when a record changes, and
 * `pnpm db:reindex` calls it to rebuild the index from scratch — so there is
 * no second copy of "what gets indexed" that can drift from this one. Which
 * fields are searchable is not decided here either: that list is
 * `SEARCHABLE_FIELDS` in `@crm/core`, the same list the API reads to decide
 * what a caller may match on.
 *
 * It reads the five record tables directly. That is a projection built from
 * the database, not a module reaching into another module's data: it runs in
 * the relay and in a maintenance script, never inside a request, and it
 * returns no record to anybody — it only ever produces an index row. The
 * alternative, asking each module's service, would put the indexer inside the
 * API process, which is the thing ADR-0006 exists to avoid.
 *
 * Every query is tenant-scoped **and** runs inside `withTenant`, so RLS
 * applies on top; and every one excludes soft-deleted rows, which is how a
 * deleted record stops being findable.
 */

/** The longest value worth indexing. Matches the CHECK in migration 0011. */
export const MAX_INDEXED_VALUE_LENGTH = 500;

/** A record as the projection reads it: ownership, freshness, and text. */
interface SourceRow {
  readonly id: string;
  /**
   * The record's ownership column — `assigned_to` for an activity (ADR-0026),
   * `owner_id` for everything else. Written out per object type below rather
   * than derived from a name, because that single irregularity is exactly the
   * kind of thing a clever generic mapping gets wrong silently, and getting it
   * wrong means record scope is applied against the wrong column.
   */
  readonly ownerId: string | null;
  readonly updatedAt: Date;
  /** Keyed by `field_definitions` key, which is also the column name. */
  readonly values: Readonly<Record<string, string | null>>;
}

async function sourceRows(
  tx: Tx,
  tenantId: string,
  objectType: SearchableObjectType,
  ids: readonly string[],
): Promise<SourceRow[]> {
  const idList = [...ids];

  switch (objectType) {
    case 'account': {
      const rows = await tx
        .select({
          id: accounts.id,
          ownerId: accounts.ownerId,
          updatedAt: accounts.updatedAt,
          name: accounts.name,
          domain: accounts.domain,
          email: sql<string | null>`${accounts.email}::text`,
          phone: accounts.phone,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.tenantId, tenantId),
            inArray(accounts.id, idList),
            isNull(accounts.deletedAt),
          ),
        );
      return rows.map(({ id, ownerId, updatedAt, ...values }) => ({
        id,
        ownerId,
        updatedAt,
        values,
      }));
    }

    case 'contact': {
      const rows = await tx
        .select({
          id: contacts.id,
          ownerId: contacts.ownerId,
          updatedAt: contacts.updatedAt,
          first_name: contacts.firstName,
          last_name: contacts.lastName,
          email: sql<string | null>`${contacts.email}::text`,
          phone: contacts.phone,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            inArray(contacts.id, idList),
            isNull(contacts.deletedAt),
          ),
        );
      return rows.map(({ id, ownerId, updatedAt, ...values }) => ({
        id,
        ownerId,
        updatedAt,
        values,
      }));
    }

    case 'lead': {
      const rows = await tx
        .select({
          id: leads.id,
          ownerId: leads.ownerId,
          updatedAt: leads.updatedAt,
          first_name: leads.firstName,
          last_name: leads.lastName,
          company: leads.company,
          email: sql<string | null>`${leads.email}::text`,
          phone: leads.phone,
        })
        .from(leads)
        .where(
          and(eq(leads.tenantId, tenantId), inArray(leads.id, idList), isNull(leads.deletedAt)),
        );
      return rows.map(({ id, ownerId, updatedAt, ...values }) => ({
        id,
        ownerId,
        updatedAt,
        values,
      }));
    }

    case 'deal': {
      const rows = await tx
        .select({
          id: deals.id,
          ownerId: deals.ownerId,
          updatedAt: deals.updatedAt,
          name: deals.name,
        })
        .from(deals)
        .where(
          and(eq(deals.tenantId, tenantId), inArray(deals.id, idList), isNull(deals.deletedAt)),
        );
      return rows.map(({ id, ownerId, updatedAt, ...values }) => ({
        id,
        ownerId,
        updatedAt,
        values,
      }));
    }

    case 'activity': {
      const rows = await tx
        .select({
          id: activities.id,
          // An activity is owned by its assignee (ADR-0026).
          ownerId: activities.assignedTo,
          updatedAt: activities.updatedAt,
          subject: activities.subject,
        })
        .from(activities)
        .where(
          and(
            eq(activities.tenantId, tenantId),
            inArray(activities.id, idList),
            isNull(activities.deletedAt),
          ),
        );
      return rows.map(({ id, ownerId, updatedAt, ...values }) => ({
        id,
        ownerId,
        updatedAt,
        values,
      }));
    }
  }
}

/**
 * The documents for these records, for the ones that are still live.
 *
 * A record that has been soft-deleted, hard-deleted or never existed produces
 * **no** document, so a caller that removes every id it did not get a document
 * for turns "deleted" into "unfindable" without needing a second query.
 */
export async function buildSearchDocuments(
  tx: Tx,
  tenantId: string,
  objectType: SearchableObjectType,
  recordIds: readonly string[],
): Promise<SearchDocument[]> {
  if (recordIds.length === 0) return [];

  const rows = await sourceRows(tx, tenantId, objectType, recordIds);

  return rows
    .map((row) => documentFor(objectType, row))
    .filter((document): document is SearchDocument => document !== null);
}

/**
 * One record's document, or null when it has nothing worth indexing.
 *
 * A contact with no name, email or phone is a row nobody can search for, and
 * an index entry with no terms would only be cost.
 */
function documentFor(objectType: SearchableObjectType, row: SourceRow): SearchDocument | null {
  const fields: SearchDocumentField[] = [];

  for (const field of SEARCHABLE_FIELDS[objectType]) {
    const raw = row.values[field.key];
    if (typeof raw !== 'string') continue;
    const value = raw.trim().slice(0, MAX_INDEXED_VALUE_LENGTH);
    if (value.length === 0) continue;
    fields.push({ fieldKey: field.key, value, weight: field.weight });
  }

  if (fields.length === 0) return null;

  return {
    objectType,
    recordId: row.id as Uuid,
    ownerId: row.ownerId as Uuid | null,
    updatedAt: row.updatedAt,
    fields,
  };
}

/** The table each object type's records live in. A closed set, never input. */
const RECORD_TABLES: Readonly<Record<SearchableObjectType, string>> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
  activity: 'activities',
};

/**
 * Every live record id of one object type, in id order, after `afterId`.
 *
 * Only `pnpm db:reindex` uses this. Keyset rather than OFFSET for the reason
 * everything else in the product is (ADR-0012): a rebuild walks a whole
 * tenant, which is exactly the size at which OFFSET stops being free.
 */
export async function liveRecordIds(
  tx: Tx,
  tenantId: string,
  objectType: SearchableObjectType,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const result = await tx.execute(
    sql`select id from ${sql.identifier(RECORD_TABLES[objectType])}
        where tenant_id = ${tenantId}
          and deleted_at is null
          and (${afterId}::uuid is null or id > ${afterId}::uuid)
        order by id
        limit ${limit}`,
  );

  return (result.rows as unknown as { id: string }[]).map((row) => row.id);
}
