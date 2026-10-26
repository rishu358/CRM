import { sql } from 'drizzle-orm';
import type { Uuid } from '@crm/core';
import { withTenant, type DbClient } from '../client.js';
import { reindexTenant } from './reindex.js';
import { PostgresSearchProvider } from './postgres.js';

/**
 * Rebuild the search index for one company or for every company (`pnpm db:reindex`, ADR-0028 §3).
 *
 * The index is a projection of the records, so it can always be rebuilt, and it must be: after a
 * restore into a database whose index is older than its records, after a bug in what gets indexed,
 * after records were written by something that does not emit outbox events. This is the operator's
 * way to do that, and until it existed the code and the docs promised a command that was not there.
 *
 * Two roles, because no single one may do both halves. Listing every company needs `crm_auth`
 * (`crm_worker` sees only the tenant it is scoped to, by RLS). Writing `search_documents` needs
 * `crm_worker` (`crm_app` may only read it, migration 0011). Each company is rebuilt in its own
 * transaction, so a failure in one leaves every other company's index as it was, and the company that
 * failed keeps its old index rather than an empty one.
 *
 * One transaction per company is also its limit: a company with millions of records is millions of
 * index rows in a single transaction. Measured at a million contacts that is a few minutes and a
 * transaction that holds its row versions until commit; run it off-peak.
 */
export interface ReindexSummary {
  readonly tenants: number;
  readonly documents: number;
  readonly failed: readonly { readonly tenantId: string; readonly error: string }[];
}

export async function reindexAll(
  clients: { readonly worker: DbClient; readonly auth: DbClient | null },
  options: { readonly tenantId?: string | undefined } = {},
  log: (message: string) => void = () => undefined,
): Promise<ReindexSummary> {
  let tenantIds: string[];
  if (options.tenantId !== undefined) {
    tenantIds = [options.tenantId];
  } else {
    if (clients.auth === null) {
      throw new Error(
        'Reindexing every company needs DATABASE_AUTH_URL (crm_auth lists them); ' +
          'pass --tenant <id> to rebuild one company with the worker role alone.',
      );
    }
    const result = await clients.auth.db.execute(
      sql`select id from tenants where deleted_at is null order by created_at`,
    );
    tenantIds = (result.rows as unknown as { id: string }[]).map((row) => row.id);
  }

  const provider = new PostgresSearchProvider();
  let documents = 0;
  let done = 0;
  const failed: { tenantId: string; error: string }[] = [];

  for (const tenantId of tenantIds) {
    try {
      const count = await withTenant(clients.worker.db, { tenantId, userId: null }, (tx) =>
        reindexTenant(tx, tenantId as Uuid, provider),
      );
      documents += count;
      done += 1;
      log(`${tenantId}: ${String(count)} documents`);
    } catch (error) {
      // Name the company and the reason, never a value from its data.
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ tenantId, error: message });
      log(`${tenantId}: FAILED (${message})`);
    }
  }

  return { tenants: done, documents, failed };
}
