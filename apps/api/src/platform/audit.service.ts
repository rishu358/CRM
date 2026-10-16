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
  | 'export'
  | 'login'
  | 'permission_change'
  | 'impersonate';

export interface AuditEntry {
  readonly action: AuditAction;
  readonly objectType: string;
  readonly recordId: string | null;
  /** `{ field: { old, new } }`. Only fields that actually changed. */
  readonly changes?: Record<string, { old?: unknown; new?: unknown }>;
}

@Injectable()
export class AuditService {
  async record(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
    const context = currentRequestContext();
    await tx.insert(auditLogs).values({
      id: newId(),
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: entry.action,
      objectType: entry.objectType,
      recordId: entry.recordId,
      changes: entry.changes ?? null,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
    });
  }
}

/**
 * Build a diff of only what changed.
 *
 * Comparing by JSON rather than identity so that two equal objects or dates do
 * not register as a change and fill the audit log with noise.
 */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { old?: unknown; new?: unknown }> {
  const changes: Record<string, { old?: unknown; new?: unknown }> = {};
  for (const key of Object.keys(after)) {
    const oldValue = before[key];
    const newValue = after[key];
    if (JSON.stringify(oldValue ?? null) !== JSON.stringify(newValue ?? null)) {
      changes[key] = { old: oldValue ?? null, new: newValue ?? null };
    }
  }
  return changes;
}
