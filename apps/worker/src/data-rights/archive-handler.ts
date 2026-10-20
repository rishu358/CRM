import {
  asInstant,
  AUDIT_DEFAULT_WINDOW_MS,
  can,
  DATA_EXPORT_CAPABILITY,
  isErasableObjectType,
  newId,
  visibleAuditChanges,
  type Actor,
  type ErasableObjectType,
  type StorageProvider,
} from '@crm/core';
import {
  and,
  auditLogs,
  dataExportJobs,
  eq,
  loadActor,
  selectArchivePage,
  selectMemberDirectory,
  selectSubjectActivities,
  selectSubjectRecord,
  selectSubjectTags,
  selectSubjectTimeline,
  sql,
  TENANT_ARCHIVE_TABLES,
  withTenant,
  type DataExportJob,
  type Database,
  type Tx,
} from '@crm/db';
import type { Logger } from 'pino';
import { csvLine, CSV_BOM } from '../import-export/csv.js';
import type { EventHandler, ExhaustedHandler, OutboxRow } from '../relay.js';

/**
 * Data-rights archives (MVP_SPEC M11).
 *
 * Three files, one handler, because all three are the same job: re-derive who
 * asked, re-check that they may still ask, stream the answer into object
 * storage, and record what left.
 *
 * The important part is the **audit-log archive**. It is the one export in the
 * product whose rows are diffs, and MVP_SPEC M3 requires a field hidden from a
 * role to be absent from audit diffs shown to that role — in exports as much as
 * on screen. It therefore passes every row through `visibleAuditChanges` from
 * `@crm/core`, the identical function `audit-log.serializer.ts` calls on the
 * request path. That is the whole reason the filter lives in `@crm/core` rather
 * than in the API: the file and the screen must agree, and two implementations
 * would not.
 *
 * Like every export in this system (ADR-0029): the actor is rebuilt from the
 * database **now**, so a capability revoked between the request and the run
 * means no file; the file is streamed rather than assembled in memory; and
 * nothing is returned through the API, which later signs a short-lived URL.
 */

export interface ArchiveDeps {
  readonly db: Database;
  readonly storage: StorageProvider;
  readonly logger: Logger;
}

const CONTENT_TYPES = {
  json: 'application/json',
  csv: 'text/csv',
} as const;

const GENERIC_FAILURE =
  'The archive could not be produced. Try again, and contact support if it keeps happening.';

/** Rows per page while streaming. Small enough to bound memory, large enough to be few round trips. */
const PAGE_ROWS = 500;

async function lockJob(tx: Tx, tenantId: string, id: string): Promise<DataExportJob | null> {
  const rows = await tx
    .select()
    .from(dataExportJobs)
    .where(and(eq(dataExportJobs.tenantId, tenantId), eq(dataExportJobs.id, id)))
    .for('update');
  return rows[0] ?? null;
}

async function failJob(tx: Tx, job: DataExportJob, reason: string): Promise<void> {
  await tx
    .update(dataExportJobs)
    .set({
      status: 'failed',
      failureReason: reason,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(dataExportJobs.tenantId, job.tenantId), eq(dataExportJobs.id, job.id)));
}

export function runDataExport(deps: ArchiveDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.record_id === null) return;

    try {
      const job = await lockJob(tx, event.tenant_id, event.record_id);
      if (job === null || job.status !== 'queued') return; // a redelivery

      const actor =
        job.createdBy === null ? null : await loadActor(tx, job.createdBy, job.tenantId);
      const capability = DATA_EXPORT_CAPABILITY[job.kind].objectType;
      const decision = actor === null ? null : can(actor, 'export', { objectType: capability });

      if (actor === null || decision === null || !decision.allowed) {
        await failJob(tx, job, 'You no longer have permission to produce this archive');
        return;
      }
      // An audit-log archive is the audit log, so it needs the same `all`-scope
      // read the viewer needs. Checked here and not only in the API, because the
      // grant may have narrowed since.
      if (job.kind === 'audit_log' && !hasTenantWideAuditRead(actor)) {
        await failJob(tx, job, 'You no longer have permission to read the audit log');
        return;
      }

      await tx
        .update(dataExportJobs)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(dataExportJobs.tenantId, job.tenantId), eq(dataExportJobs.id, job.id)));

      let rowCount = 0;
      const count = (rows: number): void => {
        rowCount += rows;
      };

      const body =
        job.kind === 'audit_log' && job.format === 'csv'
          ? auditCsvStream(tx, job, actor, count)
          : jsonStream(tx, job, actor, count);

      await deps.storage.write(job.storageKey, body, CONTENT_TYPES[job.format]);

      const stored = await deps.storage.head(job.storageKey);
      await tx
        .update(dataExportJobs)
        .set({
          status: 'completed',
          rowCount,
          sizeBytes: stored?.sizeBytes ?? null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(dataExportJobs.tenantId, job.tenantId), eq(dataExportJobs.id, job.id)));

      // How much left, recorded when it was known (CLAUDE.md §5.10, §5.11).
      await tx.insert(auditLogs).values({
        id: newId(),
        tenantId: job.tenantId,
        actorId: actor.userId,
        action: 'export',
        objectType: capability,
        recordId: job.id,
        changes: {
          completed: { new: true },
          rowCount: { new: rowCount },
          format: { new: job.format },
        },
      });
    } catch (error) {
      deps.logger.error(
        { eventId: event.id, jobId: event.record_id, attempts: event.attempts },
        `Data export failed: ${summarize(error)}`,
      );
      throw error;
    }
  };
}

/** The relay has given up: say so on the job rather than leaving it "running". */
export function failDataExportOnExhaustion(deps: ArchiveDeps): ExhaustedHandler {
  return async (event) => {
    if (event.record_id === null) return;
    const recordId = event.record_id;
    await withTenant(deps.db, { tenantId: event.tenant_id, userId: null }, async (tx) => {
      const job = await lockJob(tx, event.tenant_id, recordId);
      if (job === null || job.status === 'completed' || job.status === 'failed') return;
      await failJob(tx, job, GENERIC_FAILURE);
      await deps.storage.delete(job.storageKey).catch(() => undefined);
    });
  };
}

/**
 * `all`-scope `read` on `audit_log`.
 *
 * The same rule `AuditLogService.assertMayRead` applies, spelled out here rather
 * than imported, because the worker must not depend on the API (ADR-0001). The
 * rule itself is one line and both sides are covered by tests that compare the
 * archive against the viewer.
 */
function hasTenantWideAuditRead(actor: Actor): boolean {
  const decision = can(actor, 'read', { objectType: 'audit_log' });
  return decision.allowed && decision.scope === 'all';
}

/**
 * The audit log as CSV, a page at a time.
 *
 * One row per audit entry, with the diff rendered as JSON in a single column —
 * **after** `visibleAuditChanges` has removed what this reader may not see. A
 * column per field is impossible here: every object type has different fields
 * and the log spans all of them.
 *
 * Every cell goes through `csvLine`, so every cell goes through `toExportCell`
 * and formula injection is closed (CLAUDE.md §5.11). That includes the rendered
 * diff, which contains values a user typed.
 */
async function* auditCsvStream(
  tx: Tx,
  job: DataExportJob,
  actor: Actor,
  count: (rows: number) => void,
): AsyncGenerator<Uint8Array> {
  const headers = [
    'Occurred at',
    'Actor',
    'Actor id',
    'Action',
    'Object',
    'Record id',
    'Changes',
    'Withheld fields',
    'IP address',
    'Request id',
  ];
  yield Buffer.from(CSV_BOM + csvLine(headers), 'utf8');

  for await (const page of auditPages(tx, job)) {
    let text = '';
    for (const row of page) {
      const visible = visibleAuditChanges(actor, row.object_type, row.changes);
      text += csvLine([
        asInstant(row.occurred_at).toISOString(),
        row.actor_name,
        row.actor_id,
        row.action,
        row.object_type,
        row.record_id,
        JSON.stringify(visible.changes),
        visible.withheldFields,
        row.ip_address,
        row.request_id,
      ]);
    }
    count(page.length);
    yield Buffer.from(text, 'utf8');
  }
}

/**
 * The JSON archive.
 *
 * Written as a stream of chunks rather than one `JSON.stringify`, because a
 * whole-tenant archive of a million-record tenant does not fit in memory — and
 * the one that does today is the one that will not in two years.
 */
async function* jsonStream(
  tx: Tx,
  job: DataExportJob,
  actor: Actor,
  count: (rows: number) => void,
): AsyncGenerator<Uint8Array> {
  const encoder = (value: string): Uint8Array => Buffer.from(value, 'utf8');

  yield encoder(
    `{\n  "kind": ${JSON.stringify(job.kind)},\n  "tenantId": ${JSON.stringify(job.tenantId)},\n  "generatedAt": ${JSON.stringify(new Date().toISOString())},\n`,
  );

  if (job.kind === 'audit_log') {
    yield encoder('  "auditLog": [');
    let first = true;
    for await (const page of auditPages(tx, job)) {
      for (const row of page) {
        const visible = visibleAuditChanges(actor, row.object_type, row.changes);
        yield encoder(
          (first ? '\n    ' : ',\n    ') +
            JSON.stringify({
              id: row.id,
              occurredAt: asInstant(row.occurred_at).toISOString(),
              actorId: row.actor_id,
              actorName: row.actor_name,
              action: row.action,
              objectType: row.object_type,
              recordId: row.record_id,
              changes: visible.changes,
              withheldFields: visible.withheldFields,
              ipAddress: row.ip_address,
              requestId: row.request_id,
            }),
        );
        first = false;
      }
      count(page.length);
    }
    yield encoder('\n  ]\n}\n');
    return;
  }

  if (job.kind === 'data_subject') {
    const subject = subjectOf(job);
    if (subject === null) {
      yield encoder('  "subject": null\n}\n');
      return;
    }
    const sections = await subjectSections(tx, job.tenantId, subject, actor);
    count(sections.rows);
    yield encoder(`  "subject": ${JSON.stringify(sections.body, null, 2)}\n}\n`);
    return;
  }

  // The whole workspace, table by table, each paged by id keyset.
  yield encoder('  "tables": {');
  let firstTable = true;
  for (const table of TENANT_ARCHIVE_TABLES) {
    yield encoder(`${firstTable ? '\n    ' : ',\n    '}${JSON.stringify(table)}: [`);
    firstTable = false;

    let afterId: string | null = null;
    let firstRow = true;
    for (;;) {
      const rows: Record<string, unknown>[] = await selectArchivePage(
        tx,
        job.tenantId,
        table,
        afterId,
        PAGE_ROWS,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        yield encoder((firstRow ? '\n      ' : ',\n      ') + JSON.stringify(row, replacer));
        firstRow = false;
      }
      count(rows.length);
      const last = rows[rows.length - 1];
      if (last === undefined || rows.length < PAGE_ROWS) break;
      afterId = String(last['id']);
    }
    yield encoder(firstRow ? ']' : '\n    ]');
  }

  const members = await selectMemberDirectory(tx, job.tenantId);
  count(members.length);
  yield encoder(`\n  },\n  "members": ${JSON.stringify(members, replacer, 2)}\n}\n`);
}

/**
 * `JSON.stringify` throws on a bigint rather than rendering it, and money is a
 * bigint of minor units (CLAUDE.md §7). Rendered as a decimal string for the
 * same reason the API does on the wire: a number past 2^53 would be rounded,
 * and an archive that disagrees with the record by a rupee is worse than none.
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function subjectOf(
  job: DataExportJob,
): { objectType: ErasableObjectType; recordId: string } | null {
  const objectType = job.params.subjectObjectType;
  const recordId = job.params.subjectRecordId;
  if (!isErasableObjectType(objectType) || typeof recordId !== 'string') return null;
  return { objectType, recordId };
}

/**
 * Everything the workspace holds about one person.
 *
 * Small enough to assemble whole — one record, its activities, its timeline, its
 * tags and its history — unlike a tenant archive. The audit history goes through
 * the same field filter as everything else, because a subject access request
 * answered by an Admin who cannot read a field should not hand that field's
 * history to the subject either: the file is produced under the requester's
 * permissions, not the subject's.
 */
async function subjectSections(
  tx: Tx,
  tenantId: string,
  subject: { objectType: ErasableObjectType; recordId: string },
  actor: Actor,
): Promise<{ body: Record<string, unknown>; rows: number }> {
  const record = await selectSubjectRecord(tx, tenantId, subject.objectType, subject.recordId);
  const activities = await selectSubjectActivities(
    tx,
    tenantId,
    subject.objectType,
    subject.recordId,
  );
  const timeline = await selectSubjectTimeline(tx, tenantId, subject.objectType, subject.recordId);
  const tags = await selectSubjectTags(tx, tenantId, subject.objectType, subject.recordId);

  const history = (
    await tx.execute(sql`
      select a.id, a.occurred_at, a.actor_id, a.action, a.object_type, a.record_id,
             a.changes, a.ip_address, a.request_id, u.name as actor_name,
             a.occurred_at::text as cursor_value
      from audit_logs a
      left join users u on u.id = a.actor_id
      where a.tenant_id = ${tenantId}::uuid
        and a.object_type = ${subject.objectType}
        and a.record_id = ${subject.recordId}::uuid
      order by a.occurred_at desc, a.id desc
      limit 1000
    `)
  ).rows as unknown as AuditArchiveRow[];

  const visibleHistory = history.map((row) => {
    const visible = visibleAuditChanges(actor, row.object_type, row.changes);
    return {
      occurredAt: asInstant(row.occurred_at).toISOString(),
      actorName: row.actor_name,
      action: row.action,
      changes: visible.changes,
      withheldFields: visible.withheldFields,
    };
  });

  return {
    body: {
      objectType: subject.objectType,
      record: record === null ? null : JSON.parse(JSON.stringify(record, replacer)),
      activities,
      timeline,
      tags,
      history: visibleHistory,
    },
    rows:
      (record === null ? 0 : 1) +
      activities.length +
      timeline.length +
      tags.length +
      visibleHistory.length,
  };
}

interface AuditArchiveRow {
  readonly id: string;
  readonly occurred_at: Date | string;
  /** `occurred_at` as Postgres renders it, for the keyset cursor. */
  readonly cursor_value: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly object_type: string;
  readonly record_id: string | null;
  readonly changes: Record<string, { old?: unknown; new?: unknown }> | null;
  readonly ip_address: string | null;
  readonly request_id: string | null;
  readonly actor_name: string | null;
}

/**
 * Pages of audit rows matching the job's stored filters.
 *
 * The same query shape the viewer uses, including the bounded window: the file
 * covers the period the screen showed, and an archive request that named no
 * window gets the same 30-day default rather than the whole history — which on
 * the largest table in the database is the difference between a file and an
 * outage.
 */
async function* auditPages(tx: Tx, job: DataExportJob): AsyncGenerator<AuditArchiveRow[]> {
  const params = job.params;
  const to = params.to === undefined ? new Date() : new Date(params.to);
  const from =
    params.from === undefined
      ? new Date(to.getTime() - AUDIT_DEFAULT_WINDOW_MS)
      : new Date(params.from);

  let cursor: { cursorValue: string; id: string } | null = null;

  for (;;) {
    const rows = (
      await tx.execute(sql`
        select a.id, a.occurred_at, a.actor_id, a.action, a.object_type, a.record_id,
               a.changes, a.ip_address, a.request_id, u.name as actor_name,
               a.occurred_at::text as cursor_value
        from audit_logs a
        left join users u on u.id = a.actor_id
        where a.tenant_id = ${job.tenantId}::uuid
          and a.occurred_at >= ${from.toISOString()}::timestamptz
          and a.occurred_at < ${to.toISOString()}::timestamptz
          ${params.actorId === undefined ? sql`` : sql`and a.actor_id = ${params.actorId}::uuid`}
          ${params.objectType === undefined ? sql`` : sql`and a.object_type = ${params.objectType}`}
          ${params.action === undefined ? sql`` : sql`and a.action = ${params.action}`}
          ${params.recordId === undefined ? sql`` : sql`and a.record_id = ${params.recordId}::uuid`}
          ${
            cursor === null
              ? sql``
              : sql`and (a.occurred_at, a.id) < (${cursor.cursorValue}::timestamptz, ${cursor.id}::uuid)`
          }
        order by a.occurred_at desc, a.id desc
        limit ${PAGE_ROWS}
      `)
    ).rows as unknown as AuditArchiveRow[];

    if (rows.length === 0) return;
    yield rows;

    const last = rows[rows.length - 1];
    if (last === undefined || rows.length < PAGE_ROWS) return;
    cursor = { cursorValue: last.cursor_value, id: last.id };
  }
}

function summarize(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown error';
}
