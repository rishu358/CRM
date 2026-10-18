import { SEARCHABLE_OBJECT_TYPES, type SearchProvider, type Uuid } from '@crm/core';
import type { Tx } from '../client.js';
import { buildSearchDocuments, liveRecordIds } from './documents.js';

/**
 * Rebuild one tenant's search index from its records (ADR-0028 §3).
 *
 * The index is a projection, so it can always be rebuilt — and anything that
 * puts records into the database without emitting outbox events needs this,
 * because nothing else will index them. Two callers today: `pnpm db:seed`,
 * which inserts the demo tenant directly, and whatever one-off script a
 * deployment runs for records that predate the feature.
 *
 * It walks by keyset rather than loading a tenant at once (ADR-0012): a
 * rebuild is exactly the size at which `OFFSET` and "select everything" stop
 * being free.
 *
 * Must run in a transaction scoped to `tenantId` and as a role that may write
 * `search_documents` — `crm_worker`, not `crm_app` (migration 0011). Records
 * that have been soft-deleted are skipped by `buildSearchDocuments`, so a
 * rebuild never resurrects something from the Recycle Bin.
 */
const BATCH_SIZE = 500;

export async function reindexTenant(
  tx: Tx,
  tenantId: Uuid,
  provider: SearchProvider<Tx>,
): Promise<number> {
  // Start from nothing, so a record deleted while the index was written by
  // something other than the relay does not survive the rebuild. Same
  // transaction as the writes below, so no reader ever sees a bare index.
  await provider.clear(tx, tenantId);

  let indexed = 0;

  for (const objectType of SEARCHABLE_OBJECT_TYPES) {
    let after: string | null = null;

    for (;;) {
      const ids: string[] = await liveRecordIds(tx, tenantId, objectType, after, BATCH_SIZE);
      if (ids.length === 0) break;

      const documents = await buildSearchDocuments(tx, tenantId, objectType, ids);
      await provider.index(tx, tenantId, documents);
      indexed += documents.length;

      if (ids.length < BATCH_SIZE) break;
      after = ids[ids.length - 1] ?? null;
    }
  }

  return indexed;
}
