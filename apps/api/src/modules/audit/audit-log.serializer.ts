import { visibleAuditChanges, type Actor } from '@crm/core';
import type { AuditEntry } from '@crm/contracts';
import type { AuditLogRow } from './audit-log.repository.js';

/**
 * Field-level permissions, applied at the boundary (CLAUDE.md §5.4).
 *
 * The same role every other serializer in this codebase plays, for the one read
 * path where getting it wrong is least visible. An audit diff carries the *old
 * and new values* of fields, so a reader who cannot see `email` but can see
 * history would otherwise learn every address the contact has ever had —
 * strictly more than reading the field would have told them. MVP_SPEC M3 names
 * audit diffs explicitly for that reason.
 *
 * The filtering itself is `visibleAuditChanges` in `@crm/core`, which calls the
 * same `canReadField` as `contacts.serializer.ts`. It lives there rather than
 * here because the worker writes the exported copy of this same log and must
 * filter it identically; two implementations is how the file and the screen end
 * up disagreeing about what a reader may see.
 */
export function serializeAuditEntry(actor: Actor, row: AuditLogRow): AuditEntry {
  const visible = visibleAuditChanges(actor, row.object_type, row.changes);

  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    objectType: row.object_type,
    recordId: row.record_id,
    changes: visible.changes,
    // Said out loud rather than silently shrinking the diff: an audit log that
    // shows a reader less than happened without telling them is worse than one
    // that says something is withheld.
    withheldFields: visible.withheldFields,
    ipAddress: row.ip_address,
    requestId: row.request_id,
  };
}

export function serializeAuditEntries(
  actor: Actor,
  rows: readonly AuditLogRow[],
): AuditEntry[] {
  return rows.map((row) => serializeAuditEntry(actor, row));
}
