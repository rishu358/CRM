import {
  can,
  IMPORT_LIMITS,
  newId,
  validateMapping,
  type ObjectType,
  type StorageProvider,
} from '@crm/core';
import {
  auditLogs,
  importErrors,
  importJobs,
  importRows,
  loadActor,
  loadFieldDefinitions,
  withTenant,
  and,
  asc,
  eq,
  inArray,
  sql,
  type Database,
  type ImportJob,
  type Tx,
} from '@crm/db';
import type { Logger } from 'pino';
import { csvLine, CSV_BOM } from './csv.js';
import { publishEvent } from './events.js';
import { processChunk, processChunkWithoutWriting, type ChunkRow } from './import-rows.js';
import { openUpload, UploadRejected } from './parse.js';
import type { EventHandler, ExhaustedHandler, OutboxRow } from '../relay.js';

/**
 * The import pipeline: analyze, stage, then process in chunks
 * (MVP_SPEC §M8, ADR-0029).
 *
 *   import.uploaded.v1   analyze   validate the bytes, read header + preview,
 *                                  count rows                  -> awaiting_mapping
 *   import.started.v1    stage     re-validate, copy the rows into import_rows
 *                                                              -> processing
 *   import.chunk.v1      process   write one chunk; queue the next, or finish
 *
 * Every handler is **idempotent** (CLAUDE.md §6), because the relay delivers
 * at-least-once. The mechanism is the same throughout and is the thing to
 * understand before changing any of this:
 *
 *   A handler runs inside the relay's transaction. Its writes — the records, the
 *   audit rows, the error rows, the job's checkpoint, and the *event that
 *   queues the next step* — all commit together or not at all. So a crash
 *   leaves either "this step happened and the next is queued" or "nothing
 *   happened", never "records created, checkpoint not advanced". A redelivery
 *   of a step that did commit finds the job no longer at that step (or the
 *   checkpoint no longer at that offset) and does nothing.
 *
 * The unit of idempotency is therefore the chunk, not the row. There is no
 * per-row dedup table, and none is needed.
 */

export interface ImportDeps {
  readonly db: Database;
  readonly storage: StorageProvider;
  readonly logger: Logger;
}

const GENERIC_FAILURE =
  'The import could not be completed. Try again, and contact support if it keeps happening.';

type Status = ImportJob['status'];

async function lockJob(tx: Tx, tenantId: string, id: string): Promise<ImportJob | null> {
  const rows = await tx
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.tenantId, tenantId), eq(importJobs.id, id)))
    // The row lock is what stops two workers (or a retry racing its own
    // original) both running the same step.
    .for('update');
  return rows[0] ?? null;
}

const TERMINAL: readonly Status[] = ['completed', 'failed', 'rejected'];

/**
 * End a job without success, and clean up after it.
 *
 * Staged rows and error rows are the contents of somebody's spreadsheet; once
 * the job is over nothing reads them, so they go (data minimisation).
 */
async function endJob(
  tx: Tx,
  job: ImportJob,
  status: 'failed' | 'rejected',
  reason: string,
): Promise<void> {
  await tx
    .delete(importRows)
    .where(and(eq(importRows.tenantId, job.tenantId), eq(importRows.jobId, job.id)));
  await tx
    .delete(importErrors)
    .where(and(eq(importErrors.tenantId, job.tenantId), eq(importErrors.jobId, job.id)));
  await tx
    .update(importJobs)
    // `preview` is ten rows of the user's file, kept for the mapping screen. Once
    // the job is over nothing reads it, so it goes with the staged rows.
    .set({
      status,
      failureReason: reason,
      preview: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(importJobs.tenantId, job.tenantId), eq(importJobs.id, job.id)));
}

async function removeUpload(deps: ImportDeps, job: ImportJob): Promise<void> {
  // A check shares its file with the import it is checking, which is still waiting for its mapping
  // or about to run for real. Only that import's end may delete the file (ADR-0068).
  if (job.dryRun) return;
  try {
    await deps.storage.delete(job.storageKey);
  } catch (error) {
    // Best effort: the job is over either way, and the bucket's lifecycle rule
    // is the backstop for an object this could not remove.
    deps.logger.warn({ jobId: job.id, err: summarize(error) }, 'Could not remove an import upload');
  }
}

/** Never log a message that might carry a cell value. Name and message only, truncated. */
function summarize(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 200)}`;
  return 'unknown error';
}

/**
 * Wrap a step: lock the job, skip it if the job has moved on, and log a failure
 * before letting it propagate (the relay retries with backoff).
 *
 * What happens when the retries run out is `failImportOnExhaustion`'s job, not
 * this wrapper's: see `ExhaustedHandler` for why it cannot be done from here.
 */
function step(
  deps: ImportDeps,
  expected: Status,
  body: (tx: Tx, event: OutboxRow, job: ImportJob) => Promise<void>,
): EventHandler {
  return async (tx, event) => {
    if (event.record_id === null) return;

    try {
      const job = await lockJob(tx, event.tenant_id, event.record_id);
      if (job === null || job.status !== expected) return;
      await body(tx, event, job);
    } catch (error) {
      deps.logger.error(
        {
          eventId: event.id,
          jobId: event.record_id,
          attempts: event.attempts,
          err: summarize(error),
        },
        'Import step failed',
      );
      throw error;
    }
  };
}

/**
 * The relay has given up on an import step. Tell the user, and clean up.
 *
 * Without this a job whose step keeps throwing would sit in `processing`
 * forever: the relay abandons the *event*, and nothing else would ever notice
 * the *job*. Runs in its own transaction, after the failed attempt rolled back
 * (so the job's row lock is free) — register it for every event type that moves
 * a job along.
 */
export function failImportOnExhaustion(deps: ImportDeps): ExhaustedHandler {
  return async (event) => {
    if (event.record_id === null) return;
    const recordId = event.record_id;
    await withTenant(deps.db, { tenantId: event.tenant_id, userId: null }, async (tx) => {
      const job = await lockJob(tx, event.tenant_id, recordId);
      if (job === null || TERMINAL.includes(job.status)) return;
      await endJob(tx, job, 'failed', GENERIC_FAILURE);
      await removeUpload(deps, job);
    });
  };
}

/** Header cells as column names: bounded, and never blank. */
function columnNames(header: readonly string[], widest: number): string[] {
  const names: string[] = [];
  for (let index = 0; index < Math.max(header.length, widest); index += 1) {
    const raw = (header[index] ?? '').trim().slice(0, IMPORT_LIMITS.maxHeaderChars);
    names.push(raw === '' ? `Column ${index + 1}` : raw);
  }
  return names;
}

function pad(cells: readonly string[], width: number): string[] {
  const row = cells.slice(0, width);
  while (row.length < width) row.push('');
  return row;
}

// ---------------------------------------------------------------------------
// 1. Analyze
// ---------------------------------------------------------------------------

export function analyzeImport(deps: ImportDeps): EventHandler {
  return step(deps, 'analyzing', async (tx, _event, job) => {
    try {
      const opened = await openUpload(deps.storage, {
        storageKey: job.storageKey,
        claimedFormat: job.claimedFormat,
        declaredSize: job.sizeBytes,
      });

      const preview: string[][] = [];
      let total = 0;
      let widest = opened.header.length;
      for await (const row of opened.rows) {
        total += 1;
        widest = Math.max(widest, row.cells.length);
        if (preview.length < IMPORT_LIMITS.previewRows) {
          preview.push(row.cells.map((cell) => cell.slice(0, 200)));
        }
      }
      if (total === 0) throw new UploadRejected('The file has a header row but no data rows');

      const columns = columnNames(opened.header, widest);
      await tx
        .update(importJobs)
        .set({
          status: 'awaiting_mapping',
          detectedFormat: opened.format,
          columns,
          preview: preview.map((row) => pad(row, columns.length)),
          totalRows: total,
          updatedAt: new Date(),
        })
        .where(and(eq(importJobs.tenantId, job.tenantId), eq(importJobs.id, job.id)));
    } catch (error) {
      if (!(error instanceof UploadRejected)) throw error;
      await endJob(tx, job, 'rejected', error.message);
      await removeUpload(deps, job);
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Stage
// ---------------------------------------------------------------------------

const STAGE_BATCH = 500;

export function stageImport(deps: ImportDeps): EventHandler {
  return step(deps, 'staging', async (tx, event, job) => {
    const width = job.columns?.length ?? 0;

    try {
      // The same full validation as analysis, deliberately (see `parse.ts`): the
      // object could have been replaced between the two steps.
      const opened = await openUpload(deps.storage, {
        storageKey: job.storageKey,
        claimedFormat: job.claimedFormat,
        declaredSize: job.sizeBytes,
      });

      let count = 0;
      let batch: (typeof importRows.$inferInsert)[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await tx.insert(importRows).values(batch);
        batch = [];
      };

      for await (const row of opened.rows) {
        count += 1;
        batch.push({
          id: newId(),
          tenantId: job.tenantId,
          jobId: job.id,
          rowNumber: count,
          sourceRow: row.sourceRow,
          cells: pad(row.cells, width),
        });
        if (batch.length >= STAGE_BATCH) await flush();
      }
      await flush();

      if (count === 0) throw new UploadRejected('The file has a header row but no data rows');

      await tx
        .update(importJobs)
        .set({ status: 'processing', totalRows: count, updatedAt: new Date() })
        .where(and(eq(importJobs.tenantId, job.tenantId), eq(importJobs.id, job.id)));

      await publishEvent(tx, {
        tenantId: job.tenantId,
        actorId: event.actor_id,
        eventType: 'import.chunk.v1',
        objectType: 'import_job',
        recordId: job.id,
        payload: { startRow: 0 },
        priority: true,
      });
    } catch (error) {
      if (!(error instanceof UploadRejected)) throw error;
      await endJob(tx, job, 'rejected', error.message);
      await removeUpload(deps, job);
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Process one chunk
// ---------------------------------------------------------------------------

export function processImportChunk(deps: ImportDeps): EventHandler {
  return step(deps, 'processing', async (tx, event, job) => {
    const startRow = Number(event.payload['startRow'] ?? 0);

    // Idempotency, part one: this chunk was already done. The event is a
    // redelivery of one whose transaction committed but whose `markRelayed` did
    // not. The checkpoint is the proof, and nothing is written twice.
    if (job.processedRows !== startRow) return;

    const objectType = job.objectType;
    const object: ObjectType = objectType;

    // Who is allowed is decided *now*, not when the import was started. A role
    // revoked mid-import takes effect at the next chunk.
    const actor = job.createdBy === null ? null : await loadActor(tx, job.createdBy, job.tenantId);
    if (actor === null) {
      await endJob(tx, job, 'failed', 'The person who started this import no longer has access');
      await removeUpload(deps, job);
      return;
    }

    const mode = job.duplicateMode ?? 'create';
    const allowed =
      can(actor, 'import', { objectType: object }).allowed &&
      can(actor, 'create', { objectType: object }).allowed &&
      (mode !== 'update' || can(actor, 'update', { objectType: object }).allowed);

    const fields = await loadFieldDefinitions(tx, job.tenantId, object);
    const mapping = job.mapping ?? [];
    const issues = allowed
      ? validateMapping(actor, objectType, fields, mapping, {
          columnCount: job.columns?.length ?? 0,
          duplicateMode: mode,
          matchField: job.matchField,
        })
      : [{ path: 'permissions', message: 'permissions changed' }];

    if (!allowed || issues.length > 0) {
      await endJob(
        tx,
        job,
        'failed',
        'Your permissions or the field setup changed while the import was running, so it was stopped',
      );
      await removeUpload(deps, job);
      return;
    }

    const staged = await tx
      .select()
      .from(importRows)
      .where(
        and(
          eq(importRows.tenantId, job.tenantId),
          eq(importRows.jobId, job.id),
          sql`${importRows.rowNumber} > ${startRow}`,
        ),
      )
      .orderBy(asc(importRows.rowNumber))
      .limit(IMPORT_LIMITS.chunkRows);

    const total = job.totalRows ?? 0;
    if (staged.length === 0 && startRow < total) {
      throw new Error('Staged rows are missing for an import in progress');
    }

    const rows: ChunkRow[] = staged.map((row) => ({
      rowNumber: row.rowNumber,
      sourceRow: row.sourceRow,
      cells: row.cells,
    }));

    const chunkContext = {
      actor,
      jobId: job.id,
      objectType,
      fields,
      mapping,
      duplicateMode: mode,
      matchField: job.matchField,
    };
    const result = job.dryRun
      ? await processChunkWithoutWriting(tx, chunkContext, rows)
      : await processChunk(tx, chunkContext, rows);

    // Error rows, bounded. Beyond the cap we keep counting and stop describing.
    const recorded = Number(
      (
        await tx.execute(
          sql`select count(*)::int as n from import_errors
              where tenant_id = ${job.tenantId} and job_id = ${job.id}`,
        )
      ).rows[0]?.['n'] ?? 0,
    );
    const room = Math.max(0, IMPORT_LIMITS.maxRecordedErrors - recorded);
    const toStore = result.errors.slice(0, room);
    for (let offset = 0; offset < toStore.length; offset += 1000) {
      await tx.insert(importErrors).values(
        toStore.slice(offset, offset + 1000).map((error) => ({
          id: newId(),
          tenantId: job.tenantId,
          jobId: job.id,
          rowNumber: error.sourceRow,
          field: error.field,
          message: (error.message.trim() === '' ? 'The row was rejected' : error.message).slice(
            0,
            500,
          ),
        })),
      );
    }

    const processed = startRow + rows.length;
    await tx
      .update(importJobs)
      .set({
        processedRows: processed,
        createdCount: sql`${importJobs.createdCount} + ${result.created}`,
        updatedCount: sql`${importJobs.updatedCount} + ${result.updated}`,
        skippedCount: sql`${importJobs.skippedCount} + ${result.skipped}`,
        failedCount: sql`${importJobs.failedCount} + ${result.failed}`,
        updatedAt: new Date(),
      })
      .where(and(eq(importJobs.tenantId, job.tenantId), eq(importJobs.id, job.id)));

    if (processed >= total) {
      await finishImport(deps, tx, job, actor.userId);
      return;
    }

    // Queued in this transaction, so "this chunk is done" and "the next is
    // coming" are one fact (idempotency, part two).
    await publishEvent(tx, {
      tenantId: job.tenantId,
      actorId: event.actor_id,
      eventType: 'import.chunk.v1',
      objectType: 'import_job',
      recordId: job.id,
      payload: { startRow: processed },
      priority: true,
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Finish
// ---------------------------------------------------------------------------

/** One cell of the error file is cut here; a 32,000-character cell echoed ten thousand times is a 300 MB file. */
const ERROR_FILE_CELL_CHARS = 500;

async function finishImport(
  deps: ImportDeps,
  tx: Tx,
  job: ImportJob,
  actorId: string,
): Promise<void> {
  const fresh = await lockJob(tx, job.tenantId, job.id);
  if (fresh === null) return;

  let errorFileKey: string | null = null;

  if (fresh.failedCount > 0) {
    const errors = await tx
      .select()
      .from(importErrors)
      .where(and(eq(importErrors.tenantId, job.tenantId), eq(importErrors.jobId, job.id)))
      .orderBy(asc(importErrors.rowNumber), asc(importErrors.id));

    // The original row for each error, so the file says what was in it.
    const sourceRows = [...new Set(errors.map((error) => error.rowNumber))];
    const byRow = new Map<number, readonly string[]>();
    for (let offset = 0; offset < sourceRows.length; offset += 1000) {
      const found = await tx
        .select({ sourceRow: importRows.sourceRow, cells: importRows.cells })
        .from(importRows)
        .where(
          and(
            eq(importRows.tenantId, job.tenantId),
            eq(importRows.jobId, job.id),
            inArray(importRows.sourceRow, sourceRows.slice(offset, offset + 1000)),
          ),
        );
      for (const row of found) byRow.set(row.sourceRow, row.cells);
    }

    // Every cell goes through `csvLine`, which escapes it (§5.11). This matters
    // more here than anywhere: the error file echoes **the uploader's own
    // cells back**, so it is the one export whose contents an attacker
    // controls directly.
    const lines: string[] = [CSV_BOM, csvLine(['Row', 'Field', 'Error', ...(fresh.columns ?? [])])];
    for (const error of errors) {
      const original = (byRow.get(error.rowNumber) ?? []).map((cell) =>
        cell.slice(0, ERROR_FILE_CELL_CHARS),
      );
      lines.push(csvLine([error.rowNumber, error.field ?? '', error.message, ...original]));
    }
    const unlisted = fresh.failedCount - new Set(errors.map((error) => error.rowNumber)).size;
    if (unlisted > 0) {
      lines.push(csvLine(['', '', `${unlisted} further failed rows are not listed`]));
    }

    // A check's file has a name of its own: the import it checked will write the usual one.
    errorFileKey = `${fresh.storageKey}${fresh.dryRun ? '.check' : ''}.errors.csv`;
    await deps.storage.write(errorFileKey, Buffer.from(lines.join(''), 'utf8'), 'text/csv');
  }

  await tx
    .delete(importRows)
    .where(and(eq(importRows.tenantId, job.tenantId), eq(importRows.jobId, job.id)));
  await tx
    .delete(importErrors)
    .where(and(eq(importErrors.tenantId, job.tenantId), eq(importErrors.jobId, job.id)));

  await tx
    .update(importJobs)
    .set({
      status: 'completed',
      errorFileKey,
      preview: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(importJobs.tenantId, job.tenantId), eq(importJobs.id, job.id)));

  await tx.insert(auditLogs).values({
    id: newId(),
    tenantId: job.tenantId,
    actorId,
    action: 'import',
    objectType: 'import_job',
    recordId: job.id,
    changes: {
      ...(fresh.dryRun ? { dryRun: { new: true } } : {}),
      status: { old: 'processing', new: 'completed' },
      created: { new: fresh.createdCount },
      updated: { new: fresh.updatedCount },
      skipped: { new: fresh.skippedCount },
      failed: { new: fresh.failedCount },
    },
  });
  // Nothing was imported, so there is nothing for a notification or an automation to follow.
  if (!fresh.dryRun) {
    await publishEvent(tx, {
      tenantId: job.tenantId,
      actorId,
      eventType: 'import.completed.v1',
      objectType: 'import_job',
      recordId: job.id,
    });
  }

  // The uploaded file is no longer needed: keep customers' spreadsheets for as
  // short a time as the product needs them, which is until the import is done.
  await removeUpload(deps, job);
}
