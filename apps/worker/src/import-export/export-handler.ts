import {
  can,
  canReadField,
  EXPORT_LIMITS,
  EXPORT_MATCH_LIMIT,
  formatCell,
  isUsableSearchTerm,
  newId,
  searchableFieldKeys,
  toExportCell,
  ValidationError,
  type Actor,
  type ExportableObjectType,
  type FieldDefinition,
  type ObjectType,
  type SearchProvider,
  type StorageProvider,
  type Uuid,
} from '@crm/core';
import {
  auditLogs,
  exportJobs,
  loadActor,
  loadFieldDefinitions,
  selectPlanPage,
  withTenant,
  and,
  eq,
  type Database,
  type ExportJob,
  type RecordRow,
  type Tx,
} from '@crm/db';
import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import type { Logger } from 'pino';
import { csvLine, CSV_BOM } from './csv.js';
import { planExportQuery, type ExportQueryPlan } from './query.js';
import type { EventHandler, ExhaustedHandler, OutboxRow } from '../relay.js';

/**
 * Run an export (MVP_SPEC §M8, ADR-0029).
 *
 * An export is a list query run to completion, so every guarantee the list has
 * is applied here, by the same mechanisms and *to every row*:
 *
 *   - the actor is rebuilt from the database **now**, so permissions revoked
 *     between request and run are honoured, and `export` is re-checked;
 *   - the record-scope constraint is a WHERE clause, never a post-filter, so
 *     an `own`-scope rep's file contains their rows and the query never read
 *     anyone else's;
 *   - the columns are field metadata intersected with `canReadField`, so a
 *     hidden field has no column at all — not an empty one, which would still
 *     confirm that it exists (CLAUDE.md §5.4);
 *   - every cell is written through `toExportCell` (CLAUDE.md §5.11), custom
 *     fields and imported data included: there is no list of "columns to
 *     escape", because there is no column that is not.
 *
 * The file is streamed to object storage as it is produced. Neither the rows
 * nor the file are ever held whole in memory, and nothing is returned through
 * the API: the caller later asks for a short-lived presigned URL.
 */

export interface ExportDeps {
  readonly db: Database;
  readonly storage: StorageProvider;
  /** Which records match an export's search (ADR-0041 §5): the same seam a list's search box uses. */
  readonly search: SearchProvider<Tx>;
  readonly logger: Logger;
}

const GENERIC_FAILURE =
  'The export could not be completed. Try again, and contact support if it keeps happening.';

const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

interface ExportColumn {
  readonly header: string;
  /** The raw value for one row. Escaping happens in the writer, not here. */
  read(row: RecordRow): unknown;
}

function summarize(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown error';
}

/**
 * Which columns this actor's file has, and where each value comes from.
 *
 * Metadata-driven (ADR-0004): active fields the actor may read, in the order a
 * form shows them, system and custom alike. Plus `id` and the timestamps,
 * which the serializers treat as always visible, and the reference columns
 * that have no field type yet — each gated by `canReadField` on its own key.
 */
export function exportColumns(
  actor: Actor,
  objectType: ExportableObjectType,
  fields: readonly FieldDefinition[],
  descriptor: ExportQueryPlan['descriptor'],
): ExportColumn[] {
  const object = objectType as ObjectType;
  const columns: ExportColumn[] = [
    { header: 'ID', read: (row) => row['id'] },
    { header: 'Created at', read: (row) => iso(row['createdAt']) },
    { header: 'Updated at', read: (row) => iso(row['updatedAt']) },
  ];

  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.isActive || !canReadField(actor, object, field.key)) continue;
    seen.add(field.key);
    columns.push({
      header: field.label,
      read: field.isSystem
        ? (row) => formatSystem(field, descriptor.exportValue(row, field.key))
        : (row) =>
            formatCell(field, (row['customFields'] as Record<string, unknown> | null)?.[field.key]),
    });
  }

  for (const extra of descriptor.extraExportColumns) {
    if (seen.has(extra.key) || !canReadField(actor, object, extra.key)) continue;
    columns.push({ header: extra.label, read: (row) => descriptor.exportValue(row, extra.key) });
  }
  return columns;
}

function iso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** System values are already typed (a bigint, a string); only a few need formatting. */
function formatSystem(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (field.type === 'multi_picklist' || field.type === 'boolean') return formatCell(field, value);
  return value;
}

async function lockExport(tx: Tx, tenantId: string, id: string): Promise<ExportJob | null> {
  const rows = await tx
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.tenantId, tenantId), eq(exportJobs.id, id)))
    .for('update');
  return rows[0] ?? null;
}

async function failExport(tx: Tx, job: ExportJob, reason: string): Promise<void> {
  await tx
    .update(exportJobs)
    .set({ status: 'failed', failureReason: reason, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(exportJobs.tenantId, job.tenantId), eq(exportJobs.id, job.id)));
}

/** Pages of rows, by keyset, until there are none. Never OFFSET (CLAUDE.md §7). */
async function* pages(
  tx: Tx,
  tenantId: string,
  plan: ExportQueryPlan,
): AsyncGenerator<RecordRow[]> {
  let cursor: { value: string | null; id: string } | null = null;
  for (;;) {
    const rows = await selectPlanPage(tx, tenantId, plan, {
      limit: EXPORT_LIMITS.pageRows,
      cursor,
    });
    if (rows.length === 0) return;
    yield rows;
    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < EXPORT_LIMITS.pageRows) return;
    cursor = { value: last.cursorValue, id: String(last['id']) };
  }
}

export function runExport(deps: ExportDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.record_id === null) return;

    try {
      const job = await lockExport(tx, event.tenant_id, event.record_id);
      if (job === null || job.status !== 'queued') return; // a redelivery

      const actor =
        job.createdBy === null ? null : await loadActor(tx, job.createdBy, job.tenantId);
      const objectType = job.objectType;
      const decision = actor === null ? null : can(actor, 'export', { objectType });

      if (actor === null || decision === null || !decision.allowed) {
        await failExport(tx, job, 'You no longer have permission to export this');
        return;
      }

      await tx
        .update(exportJobs)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(exportJobs.tenantId, job.tenantId), eq(exportJobs.id, job.id)));

      const fields = await loadFieldDefinitions(tx, job.tenantId, objectType);

      // A stored query that no longer plans (a filter on a field that has since
      // been deactivated, say) will never plan: retrying it eight times with
      // backoff would only leave the job "running" for minutes before it fails
      // anyway. Deterministic errors end the job now; only the transient ones
      // (storage, database) are left to the relay's retries.
      // A searched export is the list's search made permanent: the same seam, the same words, the same
      // four scoping rules. It reads more records than a list may (a background job has no page to fill)
      // and is refused, not silently cut, when the search matches more than that.
      let matchedIds: readonly string[] | undefined;
      const term = job.query.q;
      if (term !== undefined && isUsableSearchTerm(term)) {
        const matches = await deps.search.matchRecordIds(tx, {
          tenantId: job.tenantId as Uuid,
          term,
          scope: {
            objectType,
            constraint: decision.constraint,
            fieldKeys: searchableFieldKeys(objectType).filter((key) =>
              canReadField(actor, objectType, key),
            ),
          },
          limit: EXPORT_MATCH_LIMIT,
        });
        if (matches.truncated) {
          await failExport(
            tx,
            job,
            `This search matches more than ${String(EXPORT_MATCH_LIMIT)} records. Narrow it with filters, then export again.`,
          );
          return;
        }
        matchedIds = matches.recordIds;
      }

      let plan: ExportQueryPlan;
      try {
        plan = planExportQuery(objectType, fields, job.query, decision.constraint, matchedIds);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        await failExport(
          tx,
          job,
          'The search or filters for this export are no longer valid. Start a new export.',
        );
        return;
      }
      const columns = exportColumns(actor, objectType, fields, plan.descriptor);

      let rowCount = 0;
      let tooMany = false;
      const counter = (): void => {
        rowCount += 1;
      };

      const body =
        job.format === 'csv'
          ? csvStream(tx, job.tenantId, plan, columns, counter, () => {
              tooMany = true;
            })
          : xlsxStream(tx, job.tenantId, plan, columns, counter, () => {
              tooMany = true;
            });

      await deps.storage.write(job.storageKey, body, CONTENT_TYPES[job.format]);

      if (tooMany) {
        await deps.storage.delete(job.storageKey);
        await failExport(
          tx,
          job,
          `This export has more than ${EXPORT_LIMITS.maxRows.toLocaleString('en')} rows. Narrow the filters and try again.`,
        );
        return;
      }

      const stored = await deps.storage.head(job.storageKey);
      await tx
        .update(exportJobs)
        .set({
          status: 'completed',
          rowCount,
          sizeBytes: stored?.sizeBytes ?? null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(exportJobs.tenantId, job.tenantId), eq(exportJobs.id, job.id)));

      // How much left, recorded when it was known (CLAUDE.md §5.10, §5.11).
      await tx.insert(auditLogs).values({
        id: newId(),
        tenantId: job.tenantId,
        actorId: actor.userId,
        action: 'export',
        objectType,
        recordId: job.id,
        changes: {
          completed: { new: true },
          rowCount: { new: rowCount },
          format: { new: job.format },
        },
      });
    } catch (error) {
      deps.logger.error(
        {
          eventId: event.id,
          jobId: event.record_id,
          attempts: event.attempts,
          err: summarize(error),
        },
        'Export failed',
      );
      throw error;
    }
  };
}

/** The relay has given up on an export: tell the user, from a fresh transaction (see `ExhaustedHandler`). */
export function failExportOnExhaustion(deps: ExportDeps): ExhaustedHandler {
  return async (event) => {
    if (event.record_id === null) return;
    const recordId = event.record_id;
    await withTenant(deps.db, { tenantId: event.tenant_id, userId: null }, async (tx) => {
      const job = await lockExport(tx, event.tenant_id, recordId);
      if (job === null || job.status === 'completed' || job.status === 'failed') return;
      await failExport(tx, job, GENERIC_FAILURE);
      await deps.storage.delete(job.storageKey).catch(() => undefined);
    });
  };
}

/** Rows to CSV text, a page at a time, never the whole file in memory. */
async function* csvStream(
  tx: Tx,
  tenantId: string,
  plan: ExportQueryPlan,
  columns: readonly ExportColumn[],
  onRow: () => void,
  onTooMany: () => void,
): AsyncGenerator<Uint8Array> {
  yield Buffer.from(CSV_BOM + csvLine(columns.map((column) => column.header)), 'utf8');

  let rows = 0;
  for await (const page of pages(tx, tenantId, plan)) {
    let text = '';
    for (const row of page) {
      rows += 1;
      if (rows > EXPORT_LIMITS.maxRows) {
        onTooMany();
        return;
      }
      onRow();
      text += csvLine(columns.map((column) => column.read(row)));
    }
    yield Buffer.from(text, 'utf8');
  }
}

/**
 * Rows to an .xlsx, streamed through a pass-through so the workbook is written
 * as it is produced.
 *
 * Strings are escaped exactly as in CSV. A typed number is written as a number:
 * a numeric cell cannot be a formula, so there is nothing to escape, and
 * writing every number as text would make the sheet's own columns unsummable.
 */
async function* xlsxStream(
  tx: Tx,
  tenantId: string,
  plan: ExportQueryPlan,
  columns: readonly ExportColumn[],
  onRow: () => void,
  onTooMany: () => void,
): AsyncGenerator<Uint8Array> {
  const out = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: out,
    useSharedStrings: false,
    useStyles: false,
  });
  const sheet = workbook.addWorksheet('Export');

  const produce = (async (): Promise<void> => {
    try {
      sheet.addRow(columns.map((column) => toExportCell(column.header))).commit();
      let rows = 0;
      for await (const page of pages(tx, tenantId, plan)) {
        for (const row of page) {
          rows += 1;
          if (rows > EXPORT_LIMITS.maxRows) {
            onTooMany();
            await workbook.commit();
            return;
          }
          onRow();
          sheet
            .addRow(
              columns.map((column) => {
                const value = column.read(row);
                return typeof value === 'number' && Number.isFinite(value)
                  ? value
                  : toExportCell(value);
              }),
            )
            .commit();
        }
      }
      await workbook.commit();
    } catch (error) {
      out.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  for await (const chunk of out) yield chunk as Uint8Array;
  await produce;
}
