import { ACTIONS, AUDIT_DEFAULT_WINDOW_DAYS, OBJECT_TYPES } from '@crm/core';
import { z } from 'zod';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './pagination.js';

/**
 * Audit log viewer contracts (MVP_SPEC M11).
 *
 * The viewer is a filtered read of the biggest table in the database, so the
 * query shape is part of the contract rather than an implementation detail:
 *
 *   - `from` and `to` bound the **partition key**. The schema defaults the
 *     window rather than leaving it open, because an unbounded query reads
 *     every month this tenant has ever had. A client that wants more says so
 *     explicitly and takes the cost knowingly.
 *   - `objectType` and `action` are closed sets, validated here, so neither
 *     reaches SQL as free text (CLAUDE.md §5.7).
 *   - `cursor` is keyset, like every other list (ADR-0012). An audit log is
 *     append-heavy, which is the case OFFSET handles worst.
 */

/** Re-exported so a client reading only the contracts knows the default. */
export { AUDIT_DEFAULT_WINDOW_DAYS };

/**
 * `object_type` on an audit row is wider than the permission registry: rows are
 * written about sessions, users, export jobs and the tenant itself, none of
 * which is something a role is granted on. The filter therefore accepts those
 * names too — it is a filter on recorded history, not an authorization input,
 * and what the caller may *see* is decided by `visibleAuditChanges` in
 * `@crm/core` and not by this list.
 */
export const AUDIT_PLATFORM_OBJECT_TYPES = [
  'user',
  'session',
  'tenant',
  'membership',
  'role',
  'export_job',
  'import_job',
  'data_export_job',
  'erasure_request',
  // A custom field or picklist being added, edited or switched off (MVP_SPEC M9, ADR-0039).
  'field_definition',
  // A stage of a pipeline being added, renamed, retired or restored (MVP_SPEC M5, ADR-0061).
  'pipeline_stage',
] as const;

export const auditObjectTypeSchema = z.enum([...OBJECT_TYPES, ...AUDIT_PLATFORM_OBJECT_TYPES]);
export type AuditObjectType = z.infer<typeof auditObjectTypeSchema>;

/**
 * Actions an audit row can record.
 *
 * A superset of the permission `ACTIONS`: the audit log also records things
 * that are not object actions at all — a sign-in, an impersonation, a restore
 * from the Recycle Bin, an erasure.
 */
export const AUDIT_EXTRA_ACTIONS = [
  'restore',
  'purge',
  'login',
  'logout',
  'permission_change',
  'impersonate',
  'erase',
  'redact',
  // Sample data (MVP_SPEC M2, ADR-0037): one summary row each, beside the per-record
  // `create` and `purge` rows, so "who loaded or cleared the demo records" is one filter.
  'sample_data_loaded',
  'sample_data_removed',
] as const;

export const auditActionSchema = z.enum([...ACTIONS, ...AUDIT_EXTRA_ACTIONS]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditListQuerySchema = z
  .object({
    /** Inclusive lower bound on `occurred_at`. Defaults to 30 days ago. */
    from: z.iso.datetime({ offset: true }).optional(),
    /** Exclusive upper bound on `occurred_at`. Defaults to now. */
    to: z.iso.datetime({ offset: true }).optional(),
    actorId: z.uuid().optional(),
    objectType: auditObjectTypeSchema.optional(),
    action: auditActionSchema.optional(),
    /** The history of one record. Pairs with `objectType`. */
    recordId: z.uuid().optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

/**
 * One row of the audit log, as a reader sees it.
 *
 * `changes` has already been through the field-permission filter, and
 * `withheldFields` says how many entries that removed. Reporting the count
 * rather than silently shrinking the diff is deliberate: an audit log that
 * quietly shows a reader less than happened is worse than one that tells them
 * something is hidden from them.
 */
export const auditEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  actorId: z.uuid().nullable(),
  /** Resolved from `users`, for the people this reader shares a workspace with. */
  actorName: z.string().nullable(),
  action: z.string(),
  objectType: z.string(),
  recordId: z.uuid().nullable(),
  changes: z.record(
    z.string(),
    z.object({ old: z.unknown().optional(), new: z.unknown().optional() }),
  ),
  withheldFields: z.number().int().nonnegative(),
  ipAddress: z.string().nullable(),
  requestId: z.string().nullable(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
