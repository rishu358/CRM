import { Injectable } from '@nestjs/common';
import { newId, type Actor } from '@crm/core';
import { auditLogs, type Tx } from '@crm/db';
import { currentRequestContext } from '../common/request-context.js';

/**
 * Audit writer (CLAUDE.md §5.10).
 *
 * Always called with the caller's transaction, never its own: an audit entry
 * that commits when the change rolled back is a lie, and one that is lost when
 * the change committed is a gap. Both are worse than no audit log, because both
 * are invisible.
 *
 * The table grants INSERT and SELECT only, so there is no update path to write
 * even by mistake.
 */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  /** A duplicate folded into another record, or the record that received it (ADR-0064). */
  | 'merge'
  /** A Recycle Bin record removed for good by the retention job (MVP_SPEC M4). */
  | 'purge'
  /** A DPDP/GDPR erasure, and the audit redaction it performs (MVP_SPEC M11). */
  | 'erase'
  | 'redact'
  | 'export'
  | 'import'
  | 'login'
  | 'logout'
  | 'permission_change'
  | 'impersonate';

/**
 * Who acted, for the audit row and for the outbox event beside it.
 *
 * Narrower than `Actor` on purpose: both writers need the tenant and the user
 * and nothing else, and asking for a full Actor forced the auth module — which
 * runs before any Actor exists — to fabricate one with empty permissions. A
 * fake Actor in the codebase is worth avoiding even where it is only read for
 * two fields. Invitation acceptance has the same shape: the person accepting
 * has no membership yet, so there is nothing for `can()` to compile.
 */
export interface WriterIdentity {
  readonly tenantId: string;
  readonly userId: string | null;
}

export interface AuditEntry {
  readonly action: AuditAction;
  readonly objectType: string;
  readonly recordId: string | null;
  /** `{ field: { old, new } }`. Only fields that actually changed. */
  readonly changes?: Record<string, { old?: unknown; new?: unknown }>;
}

@Injectable()
export class AuditService {
  async record(tx: Tx, actor: Actor | WriterIdentity, entry: AuditEntry): Promise<void> {
    const context = currentRequestContext();
    await tx.insert(auditLogs).values({
      id: newId(),
      tenantId: actor.tenantId,
      actorId: actor.userId ?? null,
      action: entry.action,
      objectType: entry.objectType,
      recordId: entry.recordId,
      changes: entry.changes ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
    });
  }

  /**
   * Many entries in one statement per chunk, for a change that touches many records (a merge re-points
   * up to its cap of rows). Same columns and the same transaction as `record`, one row per entry.
   */
  async recordMany(
    tx: Tx,
    actor: Actor | WriterIdentity,
    entries: readonly AuditEntry[],
  ): Promise<void> {
    const context = currentRequestContext();
    for (let start = 0; start < entries.length; start += 500) {
      await tx.insert(auditLogs).values(
        entries.slice(start, start + 500).map((entry) => ({
          id: newId(),
          tenantId: actor.tenantId,
          actorId: actor.userId ?? null,
          action: entry.action,
          objectType: entry.objectType,
          recordId: entry.recordId,
          changes: entry.changes ?? null,
          ipAddress: context?.ipAddress ?? null,
          userAgent: context?.userAgent ?? null,
          requestId: context?.requestId ?? null,
        })),
      );
    }
  }
}

// `diffChanges` moved to @crm/core so the worker can write the same diffs the API does.
export { diffChanges } from '@crm/core';
