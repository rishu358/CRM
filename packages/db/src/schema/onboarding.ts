import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * Which records began life as sample data (MVP_SPEC M2, ADR-0037).
 *
 * "Remove sample data deletes only seeded records" needs the seeded records to
 * be knowable. A flag on accounts, contacts, leads, deals and activities would
 * put an ALTER on five of the largest tables for a feature that touches a few
 * dozen rows once per tenant, and every new object type would have to remember
 * its own. A registry keyed by `(object_type, record_id)` is the polymorphic
 * shape ADR-0005 already chose, so custom objects plug in later unchanged.
 *
 * A row records how something began; nothing updates it. The API adds rows as
 * it loads sample data and removes the ones removal decides to keep (those are
 * the user's now). There is no foreign key to the target — ADR-0005 — so the
 * worker's purge sweep deletes a purged record's registration with the rest of
 * its polymorphic references.
 */
export const sampleRecords = pgTable(
  'sample_records',
  {
    ...baseColumns,
    objectType: text('object_type')
      .$type<'account' | 'contact' | 'lead' | 'deal' | 'activity'>()
      .notNull(),
    recordId: uuid('record_id').notNull(),
  },
  (table) => [
    // One registration per record. It is also the lookup removal makes — "every
    // sample record of this type in this tenant" — because the tenant and type
    // lead the key, so a second index would only repeat it.
    uniqueIndex('sample_records_target_key').on(table.tenantId, table.objectType, table.recordId),
  ],
);

export type SampleRecord = typeof sampleRecords.$inferSelect;
export type NewSampleRecord = typeof sampleRecords.$inferInsert;
