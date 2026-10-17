import { isLinkTargetType } from '@crm/core';
import { type Tx, sql } from '@crm/db';
import type { OutboxRow } from '../relay.js';

/**
 * Keeping polymorphic links honest (ADR-0005).
 *
 * ADR-0005 bought cheap new object types by giving up the database foreign
 * key on the `(object_type, record_id)` side, and said plainly that the price
 * is orphan cleanup becoming a worker's job driven by delete events. This is
 * that job.
 *
 * It reacts to the delete event of every linkable object and removes the
 * links — and the recently-viewed rows — that point at a record which is
 * **really gone**. The existence check is the whole subtlety: a delete in
 * this product is a *soft* delete, and a task about a contact sitting in the
 * Recycle Bin must survive that contact being restored. So the handler looks
 * for the row and does nothing while it is still there, which also means it
 * does the right thing the day a hard delete arrives — a Recycle Bin purge,
 * a DPDP erasure request (MVP_SPEC M11) — without being changed.
 *
 * Idempotent by construction: deleting rows that are already gone deletes
 * nothing, which is what at-least-once delivery requires (ADR-0006).
 */

/**
 * `object_type` to the table that holds it.
 *
 * A lookup rather than string interpolation of the event's value: the event
 * came from our own outbox, but a table name assembled from a column is one
 * refactor away from being a table name assembled from user input
 * (CLAUDE.md §5.7).
 */
const TABLE_FOR_OBJECT: Readonly<Record<string, string>> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
};

export async function pruneActivityLinks(tx: Tx, event: OutboxRow): Promise<void> {
  const objectType = event.object_type;
  const recordId = event.record_id;
  if (objectType === null || recordId === null || !isLinkTargetType(objectType)) return;

  const table = TABLE_FOR_OBJECT[objectType];
  if (table === undefined) return;

  const existing = await tx.execute(
    sql`select 1 as present from ${sql.identifier(table)} where id = ${recordId} limit 1`,
  );
  // Soft-deleted but still there: the record can come back from the Recycle
  // Bin, and its activities should still be attached when it does.
  if (existing.rows.length > 0) return;

  await tx.execute(
    sql`delete from activity_links
        where tenant_id = ${event.tenant_id}
          and object_type = ${objectType}
          and record_id = ${recordId}`,
  );
  await tx.execute(
    sql`delete from record_views
        where tenant_id = ${event.tenant_id}
          and object_type = ${objectType}
          and record_id = ${recordId}`,
  );
}
