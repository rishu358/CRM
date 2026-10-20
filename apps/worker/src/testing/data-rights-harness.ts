import { newId, type DataExportKind } from '@crm/core';
import {
  createDbClient,
  dataExportJobs,
  erasureRequests,
  outboxEvents,
  withTenant,
  and,
  eq,
  type DataExportJob,
  type DbClient,
  type ErasureRequest,
} from '@crm/db';
import { provisionTenantDefaults } from '@crm/db/seed';
import { Fixtures, typedPool, type TestDbUrls, type TypedPool } from '@crm/db/testing';
import { MemoryStorageProvider } from '@crm/storage';
import pg from 'pg';
import { pino } from 'pino';
import { runDataExport, failDataExportOnExhaustion } from '../data-rights/archive-handler.js';
import {
  failErasureOnExhaustion,
  runErasure,
  runErasureRedaction,
} from '../data-rights/erasure-handler.js';
import { pruneActivityLinks } from '../handlers/activities.js';
import { rearmSweepOnExhaustion, runPurgeSweep } from '../handlers/recycle-bin.js';
import { OutboxRelay } from '../relay.js';

/**
 * Drives the Recycle Bin purge, the data-rights archives and erasure through the
 * **real** relay (MVP_SPEC M4, M11).
 *
 * It plays the API's part directly in the database — inserting the job or
 * request row the controller would have inserted — because the worker's tests
 * must not depend on the API, and because it lets a test put a job in states the
 * API would never produce. Everything from the event onward is production code:
 * the real relay claims the real outbox row and runs the real handler inside a
 * tenant-scoped transaction.
 *
 * The erasure connection is the production one too: a second pool as
 * `crm_erasure`, which is the only role that may rewrite an audit diff
 * (ADR-0032). A test that wants to prove erasure fails *without* it passes
 * `withoutErasureRole`.
 */
export interface DataRightsHarness {
  readonly db: DbClient;
  readonly erasureDb: DbClient | null;
  /** Superuser access, for seeding and for reading back what the worker wrote. */
  readonly pool: TypedPool;
  readonly fixtures: Fixtures;
  readonly storage: MemoryStorageProvider;
  readonly relay: OutboxRelay;
  readonly tenantId: string;
  readonly roleIds: ReadonlyMap<string, string>;

  user(roleName: string): Promise<string>;
  /** A second workspace, so every isolation test has a neighbour to not see. */
  otherTenant(): Promise<{ tenantId: string; roleIds: ReadonlyMap<string, string> }>;

  /** `POST /data-exports`: create the job and queue it. */
  requestArchive(options: {
    userId: string;
    kind: DataExportKind;
    format?: 'json' | 'csv';
    params?: Record<string, unknown>;
    tenantId?: string;
  }): Promise<string>;
  archive(jobId: string): Promise<DataExportJob>;

  /** `POST /erasure-requests`: record it and queue it. */
  requestErasure(options: {
    userId: string;
    subjectObjectType: 'contact' | 'lead';
    subjectRecordId: string;
    tenantId?: string;
  }): Promise<string>;
  erasure(requestId: string): Promise<ErasureRequest>;

  /** Queue a purge sweep as provisioning would have, due now. */
  queueSweep(tenantId?: string): Promise<void>;

  /** Run the relay until nothing is left to claim. Returns how many it processed. */
  drain(limit?: number): Promise<number>;
  /** The text of a stored file. */
  readText(key: string): string;
  close(): Promise<void>;
}

const logger = pino({ level: 'silent' });

export async function startDataRightsHarness(
  urls: TestDbUrls,
  options: { name?: string; withoutErasureRole?: boolean } = {},
): Promise<DataRightsHarness> {
  const db = createDbClient({ connectionString: urls.worker, maxConnections: 6 });
  const erasureDb =
    options.withoutErasureRole === true
      ? null
      : createDbClient({ connectionString: urls.erasure, maxConnections: 2 });
  const rawPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  const pool = typedPool(rawPool);
  const fixtures = new Fixtures(rawPool);
  const storage = new MemoryStorageProvider();

  const tenantId = (await fixtures.createTenant({ name: options.name ?? 'Data Rights Harness' }))
    .tenantId;
  const provisioned = await withTenant(db.db, { tenantId, userId: null }, (tx) =>
    provisionTenantDefaults(tx, tenantId, null),
  );

  const archiveDeps = { db: db.db, storage, logger };
  const erasureDeps = { db: db.db, erasureDb: erasureDb?.db ?? null, logger };

  const relay = new OutboxRelay(db.db, { logger, batchSize: 100 })
    .on('recycle_bin.sweep_due.v1', runPurgeSweep())
    .on('data_export.requested.v1', runDataExport(archiveDeps))
    .on('erasure.requested.v1', runErasure(erasureDeps))
    .on('erasure.claimed.v1', runErasureRedaction(erasureDeps))
    // Subscribed so the purge's own cleanup can be distinguished from this
    // handler's: it runs on the delete event and does nothing while the row is
    // still there, which is the behaviour the Bin depends on.
    .on('contact.deleted.v1', pruneActivityLinks)
    .onExhausted('data_export.requested.v1', failDataExportOnExhaustion(archiveDeps))
    .onExhausted('erasure.requested.v1', failErasureOnExhaustion(erasureDeps))
    .onExhausted('erasure.claimed.v1', failErasureOnExhaustion(erasureDeps))
    .onExhausted(
      'recycle_bin.sweep_due.v1',
      rearmSweepOnExhaustion({
        withTenant: (tenant, work) => withTenant(db.db, { tenantId: tenant, userId: null }, work),
      }),
    );

  return {
    db,
    erasureDb,
    pool,
    fixtures,
    storage,
    relay,
    tenantId,
    roleIds: provisioned.roleIdsByName,

    async user(roleName) {
      const roleId = provisioned.roleIdsByName.get(roleName);
      if (roleId === undefined) throw new Error(`No role ${roleName}`);
      return (await fixtures.createUser(tenantId, roleId)).userId;
    },

    async otherTenant() {
      const other = (await fixtures.createTenant({ name: `Neighbour ${newId().slice(0, 8)}` }))
        .tenantId;
      const result = await withTenant(db.db, { tenantId: other, userId: null }, (tx) =>
        provisionTenantDefaults(tx, other, null),
      );
      return { tenantId: other, roleIds: result.roleIdsByName };
    },

    async requestArchive({ userId, kind, format = 'json', params = {}, tenantId: forTenant }) {
      const tenant = forTenant ?? tenantId;
      const id = newId();
      await withTenant(db.db, { tenantId: tenant, userId }, async (tx) => {
        await tx.insert(dataExportJobs).values({
          id,
          tenantId: tenant,
          kind,
          status: 'queued',
          format,
          params,
          storageKey: `tenants/${tenant}/data-exports/${newId()}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: userId,
          updatedBy: userId,
        });
        await tx.insert(outboxEvents).values({
          id: newId(),
          tenantId: tenant,
          eventType: 'data_export.requested.v1',
          objectType: 'data_export_job',
          recordId: id,
          actorId: userId,
        });
      });
      return id;
    },

    async archive(jobId) {
      const rows = await withTenant(db.db, { tenantId, userId: null }, (tx) =>
        tx.select().from(dataExportJobs).where(eq(dataExportJobs.id, jobId)).limit(1),
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`No archive ${jobId}`);
      return row;
    },

    async requestErasure({ userId, subjectObjectType, subjectRecordId, tenantId: forTenant }) {
      const tenant = forTenant ?? tenantId;
      const id = newId();
      await withTenant(db.db, { tenantId: tenant, userId }, async (tx) => {
        await tx.insert(erasureRequests).values({
          id,
          tenantId: tenant,
          subjectObjectType,
          subjectRecordId,
          status: 'pending',
          createdBy: userId,
          updatedBy: userId,
        });
        await tx.insert(outboxEvents).values({
          id: newId(),
          tenantId: tenant,
          eventType: 'erasure.requested.v1',
          objectType: 'erasure_request',
          recordId: id,
          payload: { subjectObjectType, subjectRecordId },
          actorId: userId,
        });
      });
      return id;
    },

    async erasure(requestId) {
      const rows = await withTenant(db.db, { tenantId, userId: null }, (tx) =>
        tx.select().from(erasureRequests).where(eq(erasureRequests.id, requestId)).limit(1),
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`No erasure request ${requestId}`);
      return row;
    },

    async queueSweep(forTenant) {
      const tenant = forTenant ?? tenantId;
      await withTenant(db.db, { tenantId: tenant, userId: null }, async (tx) => {
        // Clear any sweep provisioning armed for the future, so the test's own
        // sweep is the one that runs.
        await tx
          .delete(outboxEvents)
          .where(
            and(
              eq(outboxEvents.tenantId, tenant),
              eq(outboxEvents.eventType, 'recycle_bin.sweep_due.v1'),
              eq(outboxEvents.status, 'pending'),
            ),
          );
        await tx.insert(outboxEvents).values({
          id: newId(),
          tenantId: tenant,
          eventType: 'recycle_bin.sweep_due.v1',
          objectType: 'tenant',
          recordId: tenant,
        });
      });
    },

    async drain(limit = 50) {
      let processed = 0;
      for (let pass = 0; pass < limit; pass += 1) {
        const batch = await relay.tick();
        if (batch === 0) break;
        processed += batch;
      }
      return processed;
    },

    readText(key) {
      // The CSV writer prefixes a byte-order mark so Excel reads UTF-8; escaped
      // here rather than written literally, because a raw BOM in a source file
      // is invisible in review.
      return Buffer.from(storage.bytesOf(key))
        .toString('utf8')
        .replace(/^\uFEFF/, '');
    },

    close: async () => {
      await Promise.all([db.close(), erasureDb?.close() ?? Promise.resolve(), rawPool.end()]);
    },
  };
}
