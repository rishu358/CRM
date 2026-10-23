import { newId } from '@crm/core';
import {
  createDbClient,
  exportJobs,
  importJobs,
  outboxEvents,
  withTenant,
  and,
  eq,
  type DbClient,
  type ExportJob,
  type ImportDuplicateMode,
  type ImportJob,
  type ImportMappingEntry,
  PostgresSearchProvider,
} from '@crm/db';
import { provisionAsApp } from './provision.js';
import { Fixtures, typedPool, type TestDbUrls, type TypedPool } from '@crm/db/testing';
import { MemoryStorageProvider } from '@crm/storage';
import pg from 'pg';
import { pino } from 'pino';
import { failExportOnExhaustion, runExport } from '../import-export/export-handler.js';
import {
  analyzeImport,
  failImportOnExhaustion,
  processImportChunk,
  stageImport,
} from '../import-export/import-handlers.js';
import { OutboxRelay } from '../relay.js';
import { drainRelay } from './drain.js';

/**
 * Drives the import and export pipeline through the real relay.
 *
 * It plays the API's part directly in the database — creating the job row and
 * making the transitions `ImportsService` makes — because the worker's tests
 * must not depend on the API, and because it lets a test put the job in any
 * state it likes, including ones the API would never produce, to see what the
 * worker does with them. Everything from the event onward is the production
 * path: the real relay claims the real outbox row and runs the real handler
 * inside a tenant-scoped transaction as `crm_worker`.
 */
export interface WorkerHarness {
  readonly db: DbClient;
  /** Superuser access, for seeding and for reading back what the app wrote. Rows are `unknown`. */
  readonly pool: TypedPool;
  readonly fixtures: Fixtures;
  readonly storage: MemoryStorageProvider;
  readonly relay: OutboxRelay;
  readonly tenantId: string;
  readonly roleIds: ReadonlyMap<string, string>;

  /** A user with one of the default roles (`Owner`, `Admin`, `Manager`, `Sales Rep`, `Read-only`). */
  user(roleName: string): Promise<string>;
  /** Put a file in storage and create the job as `POST /imports` would. */
  upload(options: {
    userId: string;
    objectType?: 'account' | 'contact' | 'lead';
    fileName?: string;
    bytes: Uint8Array;
    claimedFormat?: 'csv' | 'xlsx';
    tenantId?: string;
  }): Promise<string>;
  /** `POST /imports/{id}/uploaded`: move to analyzing and queue the event. */
  confirmUpload(jobId: string): Promise<void>;
  /** `POST /imports/{id}/start`. */
  start(
    jobId: string,
    input: {
      mapping: ImportMappingEntry[];
      duplicateMode?: ImportDuplicateMode;
      matchField?: string | null;
    },
  ): Promise<void>;
  /** Upload, confirm, drain: the job as it stands once analysis has run. */
  analyze(options: Parameters<WorkerHarness['upload']>[0]): Promise<ImportJob>;
  /** Run the relay until nothing is left to claim. Returns how many events it processed. */
  drain(limit?: number): Promise<number>;
  job(jobId: string): Promise<ImportJob>;
  /** Create a custom field, as an admin would (ADR-0004). */
  addCustomField(
    objectType: string,
    field: {
      key: string;
      label?: string;
      type: string;
      options?: { value: string; label: string }[];
      required?: boolean;
    },
  ): Promise<void>;
  /** `POST /exports`: create the job and queue it. */
  requestExport(options: {
    userId: string;
    objectType: 'account' | 'contact' | 'lead' | 'deal';
    format?: 'csv' | 'xlsx';
    query?: ExportJob['query'];
  }): Promise<string>;
  exportJob(jobId: string): Promise<ExportJob>;
  /** The text of a stored file, minus a leading BOM. */
  readText(key: string): string;
  contactsOf(tenantId?: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const logger = pino({ level: 'silent' });

/** `[['a','b'],['1','2']]` -> CSV text, quoted where it must be. */
export function csv(rows: readonly (readonly (string | number)[])[]): Buffer {
  const quote = (cell: string | number): string => {
    const text = String(cell);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return Buffer.from(rows.map((row) => row.map(quote).join(',')).join('\n') + '\n', 'utf8');
}

export async function startImportHarness(
  urls: TestDbUrls,
  options: { name?: string } = {},
): Promise<WorkerHarness> {
  const db = createDbClient({ connectionString: urls.worker, maxConnections: 6 });
  const rawPool = new pg.Pool({ connectionString: urls.superuser, max: 4 });
  const pool = typedPool(rawPool);
  const fixtures = new Fixtures(rawPool);
  const storage = new MemoryStorageProvider();

  const tenantId = (await fixtures.createTenant({ name: options.name ?? 'Import Harness' }))
    .tenantId;
  const provisioned = await provisionAsApp(urls.app, tenantId);
  const roleIds = provisioned.roleIdsByName;

  const deps = { db: db.db, storage, search: new PostgresSearchProvider(), logger };
  const relay = new OutboxRelay(db.db, { logger, batchSize: 100 })
    .on('import.uploaded.v1', analyzeImport(deps))
    .on('import.started.v1', stageImport(deps))
    .on('import.chunk.v1', processImportChunk(deps))
    .on('export.requested.v1', runExport(deps))
    .onExhausted('import.uploaded.v1', failImportOnExhaustion(deps))
    .onExhausted('import.started.v1', failImportOnExhaustion(deps))
    .onExhausted('import.chunk.v1', failImportOnExhaustion(deps))
    .onExhausted('export.requested.v1', failExportOnExhaustion(deps));

  async function publish(
    tenant: string,
    userId: string,
    eventType: string,
    objectType: string,
    recordId: string,
  ): Promise<void> {
    await withTenant(db.db, { tenantId: tenant, userId }, (tx) =>
      tx.insert(outboxEvents).values({
        id: newId(),
        tenantId: tenant,
        eventType,
        objectType,
        recordId,
        payload: {},
        actorId: userId,
      }),
    );
  }

  const harness: WorkerHarness = {
    db,
    pool,
    fixtures,
    storage,
    relay,
    tenantId,
    roleIds,

    async user(roleName) {
      const roleId = roleIds.get(roleName);
      if (roleId === undefined) throw new Error(`No role ${roleName}`);
      return (await fixtures.createUser(tenantId, roleId)).userId;
    },

    async upload({
      userId,
      objectType = 'contact',
      fileName,
      bytes,
      claimedFormat,
      tenantId: forTenant,
    }) {
      const tenant = forTenant ?? tenantId;
      const format = claimedFormat ?? 'csv';
      const id = newId();
      const key = `tenants/${tenant}/imports/${newId()}`;
      storage.put(key, bytes);
      await withTenant(db.db, { tenantId: tenant, userId }, (tx) =>
        tx.insert(importJobs).values({
          id,
          tenantId: tenant,
          objectType,
          status: 'awaiting_upload',
          fileName: fileName ?? `file.${format}`,
          claimedFormat: format,
          storageKey: key,
          sizeBytes: bytes.length,
          createdBy: userId,
          updatedBy: userId,
        }),
      );
      return id;
    },

    async confirmUpload(jobId) {
      const job = await harness.job(jobId);
      await withTenant(db.db, { tenantId: job.tenantId, userId: job.createdBy }, async (tx) => {
        await tx
          .update(importJobs)
          .set({ status: 'analyzing', updatedAt: new Date() })
          .where(and(eq(importJobs.tenantId, job.tenantId), eq(importJobs.id, jobId)));
      });
      await publish(
        job.tenantId,
        job.createdBy as string,
        'import.uploaded.v1',
        'import_job',
        jobId,
      );
    },

    async start(jobId, { mapping, duplicateMode = 'create', matchField = null }) {
      const job = await harness.job(jobId);
      await withTenant(db.db, { tenantId: job.tenantId, userId: job.createdBy }, async (tx) => {
        await tx
          .update(importJobs)
          .set({
            status: 'staging',
            mapping,
            duplicateMode,
            matchField: duplicateMode === 'create' ? null : matchField,
            startedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(importJobs.tenantId, job.tenantId), eq(importJobs.id, jobId)));
      });
      await publish(
        job.tenantId,
        job.createdBy as string,
        'import.started.v1',
        'import_job',
        jobId,
      );
    },

    async analyze(options) {
      const jobId = await harness.upload(options);
      await harness.confirmUpload(jobId);
      await harness.drain();
      return harness.job(jobId);
    },

    drain(limit = 5000) {
      return drainRelay(relay, rawPool, { limit });
    },

    async job(jobId) {
      // crm_worker is tenant-scoped on this table; look the tenant up through
      // the superuser so a test can read any job.
      const found = await pool.query('select tenant_id from import_jobs where id = $1', [jobId]);
      const tenant = found.rows[0]?.['tenant_id'];
      if (typeof tenant !== 'string') throw new Error(`No import job ${jobId}`);
      const [job] = await withTenant(db.db, { tenantId: tenant, userId: null }, (tx) =>
        tx.select().from(importJobs).where(eq(importJobs.id, jobId)),
      );
      if (job === undefined) throw new Error(`No import job ${jobId}`);
      return job;
    },

    async addCustomField(objectType, field) {
      await pool.query(
        `INSERT INTO field_definitions
           (id, tenant_id, object_type, key, label, type, required, options, position, is_system, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 500, false, true)`,
        [
          newId(),
          tenantId,
          objectType,
          field.key,
          field.label ?? field.key,
          field.type,
          field.required ?? false,
          field.options === undefined ? null : JSON.stringify(field.options),
        ],
      );
    },

    async requestExport({ userId, objectType, format = 'csv', query = {} }) {
      const id = newId();
      await withTenant(db.db, { tenantId, userId }, (tx) =>
        tx.insert(exportJobs).values({
          id,
          tenantId,
          objectType,
          status: 'queued',
          format,
          query,
          storageKey: `tenants/${tenantId}/exports/${newId()}`,
          expiresAt: new Date(Date.now() + 24 * 3_600_000),
          createdBy: userId,
          updatedBy: userId,
        }),
      );
      await publish(tenantId, userId, 'export.requested.v1', 'export_job', id);
      await harness.drain();
      return id;
    },

    async exportJob(jobId) {
      const [job] = await withTenant(db.db, { tenantId, userId: null }, (tx) =>
        tx.select().from(exportJobs).where(eq(exportJobs.id, jobId)),
      );
      if (job === undefined) throw new Error(`No export job ${jobId}`);
      return job;
    },

    readText(key) {
      const bytes = storage.bytesOf(key);
      return Buffer.from(bytes)
        .toString('utf8')
        .replace(/^\uFEFF/, '');
    },

    async contactsOf(forTenant) {
      const result = await pool.query(
        'select * from contacts where tenant_id = $1 and deleted_at is null order by created_at, id',
        [forTenant ?? tenantId],
      );
      return result.rows;
    },

    async close() {
      // Leave the shared queue as found. The relay claims across every tenant and
      // some suites (the relay's own) assert the whole table has nothing pending,
      // so an event this harness left behind — a backed-off retry, say — would
      // fail a test in an unrelated file.
      await pool.query(`delete from outbox_events where tenant_id = $1 and status = 'pending'`, [
        tenantId,
      ]);
      await Promise.all([db.close(), pool.end()]);
    },
  };

  return harness;
}
