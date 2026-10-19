import { can, isErasableObjectType, newId, type Actor, type ErasableObjectType } from '@crm/core';
import {
  and,
  auditLogs,
  eq,
  erasePersonalColumns,
  erasureRequests,
  loadActor,
  outboxEvents,
  redactAuditDiffs,
  withTenant,
  type Database,
  type ErasureRequest,
  type Tx,
} from '@crm/db';
import type { Logger } from 'pino';
import type { EventHandler, ExhaustedHandler, OutboxRow } from '../relay.js';

/**
 * Carry out an erasure (MVP_SPEC M11, ADR-0032).
 *
 * **Read ADR-0032 before changing this file.** It resolves a real conflict
 * between two requirements, neither of which the product may drop:
 *
 *   - CLAUDE.md §5.10: the audit log is append-only, enforced by *withholding*
 *     UPDATE and DELETE from the application role rather than by a policy, so
 *     no later migration can quietly undo it;
 *   - DPDP §12 and GDPR Art. 17: on request, personal values must stop being
 *     readable — and MVP_SPEC M11 states the resolution, that the audit row is
 *     *kept* with personal values replaced by `[erased]`.
 *
 * Replacing a value is an UPDATE, so something must be able to perform one. The
 * answer is not to widen `crm_app`. It is a fifth database role, `crm_erasure`,
 * which:
 *
 *   - the API holds no credentials for — only this handler connects as it;
 *   - has `UPDATE (changes)` and nothing else, so who did what to which record
 *     and when is immutable even here;
 *   - has no INSERT and no DELETE, so it can neither fabricate nor remove
 *     history;
 *   - is admitted by policy only to rows whose subject has an
 *     `erasure_requests` row in `processing`.
 *
 * **Two events, because the window has to be committed before another
 * connection can see it.** `crm_erasure` is a different session; an uncommitted
 * `processing` row is invisible to it, so the claim and the redaction cannot
 * share a transaction. Rather than reach outside the relay's transaction and
 * invent our own commit boundary, the claim *publishes the next step*:
 *
 *   1. `erasure.requested.v1` → `runErasure` claims the request, moves it to
 *      `processing` and queues `erasure.claimed.v1` in the same transaction.
 *      The window and the instruction to use it commit together, which is
 *      exactly the guarantee the transactional outbox exists to give
 *      (ADR-0006).
 *   2. `erasure.claimed.v1` → `runErasureRedaction` redacts the diffs on the
 *      `crm_erasure` connection, then erases the record's personal columns,
 *      records the counts and closes the window as `crm_worker`.
 *
 * Idempotent throughout, as at-least-once delivery requires: each step is
 * guarded on the request's status, redacting an already-redacted row rewrites
 * the same placeholder, and erasing an already-erased column writes the same
 * value.
 */

export interface ErasureDeps {
  readonly db: Database;
  /**
   * A second pool, connected as `crm_erasure`.
   *
   * The only place in the codebase that holds it. If it is absent — a
   * deployment that has not provisioned the role — the request is failed
   * loudly rather than the record being erased while its history is silently
   * left intact, which would be a compliance failure reported as a success.
   */
  readonly erasureDb: Database | null;
  readonly logger: Logger;
}

/** Step 1: claim the request and queue the redaction. */
export function runErasure(deps: ErasureDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.record_id === null) return;
    const requestId = event.record_id;

    const claimed = await claim(tx, event.tenant_id, requestId);
    if (claimed === null) return; // a redelivery, or already finished

    const subject = subjectOf(claimed);
    if (subject === null) {
      await fail(tx, event.tenant_id, requestId, 'Unknown subject object type');
      return;
    }

    // Judged **now**, not when it was asked for: an Owner whose capability was
    // revoked in between does not get an erasure.
    const actor =
      claimed.createdBy === null ? null : await loadActor(tx, claimed.createdBy, event.tenant_id);
    if (actor === null || !mayErase(actor)) {
      await fail(
        tx,
        event.tenant_id,
        requestId,
        'The requester no longer has permission to erase personal data',
      );
      return;
    }

    if (deps.erasureDb === null) {
      await fail(tx, event.tenant_id, requestId, 'Erasure is not configured on this deployment');
      deps.logger.error(
        { tenantId: event.tenant_id, requestId },
        'DATABASE_ERASURE_URL is not set, so audit diffs cannot be redacted',
      );
      return;
    }

    await tx.insert(outboxEvents).values({
      id: newId(),
      tenantId: event.tenant_id,
      eventType: 'erasure.claimed.v1',
      objectType: 'erasure_request',
      recordId: requestId,
      payload: {
        subjectObjectType: subject.objectType,
        subjectRecordId: subject.recordId,
      },
      actorId: claimed.createdBy,
    });
  };
}

/**
 * Step 2: redact the diffs, erase the record, close the window.
 *
 * The redaction runs on the `crm_erasure` connection in a transaction of its
 * own, which is a write made from inside a handler whose own transaction may
 * still roll back. That is safe here and nowhere else: redaction is idempotent,
 * and the window stays open until the request reaches `completed`, so a
 * rollback followed by a redelivery simply does it again. The ordering also
 * matters — the diffs are redacted **before** the record is erased, so a
 * failure in between leaves a record that is still readable rather than history
 * that still holds values for a record nobody can see.
 */
export function runErasureRedaction(deps: ErasureDeps): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.record_id === null) return;
    const erasureDb = deps.erasureDb;
    if (erasureDb === null) return;

    const requestId = event.record_id;
    const request = await loadRequest(tx, event.tenant_id, requestId);
    if (request === null || request.status !== 'processing') return;

    const subject = subjectOf(request);
    if (subject === null) return;

    // The one UPDATE on audit_logs in the system, on the one connection
    // permitted to make it, inside the window the claim opened.
    const auditRowsRedacted = await withTenant(
      erasureDb,
      { tenantId: event.tenant_id, userId: request.createdBy },
      (redactTx) =>
        redactAuditDiffs(redactTx, event.tenant_id, subject.objectType, subject.recordId),
    );

    const outcome = await erasePersonalColumns(
      tx,
      event.tenant_id,
      subject.objectType,
      subject.recordId,
      request.createdBy,
    );

    await tx
      .update(erasureRequests)
      .set({
        status: 'completed',
        recordsErased: outcome.recordsErased,
        auditRowsRedacted,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(erasureRequests.tenantId, event.tenant_id), eq(erasureRequests.id, requestId)));

    // The erasure's own audit entry carries **counts, not values**. Recording
    // what was erased would make this row the last place the erased data still
    // lives, defeating the redaction it is reporting.
    await tx.insert(auditLogs).values({
      id: newId(),
      tenantId: event.tenant_id,
      actorId: request.createdBy,
      action: 'redact',
      objectType: subject.objectType,
      recordId: subject.recordId,
      changes: {
        recordsErased: { new: outcome.recordsErased },
        auditRowsRedacted: { new: auditRowsRedacted },
      },
    });

    // The record changed, so search, the timeline and anything else projecting
    // from it must hear about it like any other change (ADR-0006). It is also
    // soft-deleted now, so the search handler removes it.
    await tx.insert(outboxEvents).values({
      id: newId(),
      tenantId: event.tenant_id,
      eventType: `${subject.objectType}.deleted.v1`,
      objectType: subject.objectType,
      recordId: subject.recordId,
      payload: { erased: true },
      actorId: request.createdBy,
    });
  };
}

async function claim(
  tx: Tx,
  tenantId: string,
  requestId: string,
): Promise<ErasureRequest | null> {
  const rows = await tx
    .update(erasureRequests)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(
      and(
        eq(erasureRequests.tenantId, tenantId),
        eq(erasureRequests.id, requestId),
        eq(erasureRequests.status, 'pending'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

async function loadRequest(
  tx: Tx,
  tenantId: string,
  requestId: string,
): Promise<ErasureRequest | null> {
  const rows = await tx
    .select()
    .from(erasureRequests)
    .where(and(eq(erasureRequests.tenantId, tenantId), eq(erasureRequests.id, requestId)))
    .limit(1);
  return rows[0] ?? null;
}

async function fail(
  tx: Tx,
  tenantId: string,
  requestId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(erasureRequests)
    .set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
    .where(and(eq(erasureRequests.tenantId, tenantId), eq(erasureRequests.id, requestId)));
}

function mayErase(actor: Actor): boolean {
  return can(actor, 'delete', { objectType: 'data_subject' }).allowed;
}

function subjectOf(
  request: ErasureRequest,
): { objectType: ErasableObjectType; recordId: string } | null {
  if (!isErasableObjectType(request.subjectObjectType)) return null;
  return { objectType: request.subjectObjectType, recordId: request.subjectRecordId };
}

/**
 * The relay has given up on an erasure.
 *
 * A request left in `processing` means the redaction window is still open,
 * which is the one state this design must not leave behind. Closed here, from a
 * fresh transaction (see `ExhaustedHandler`), with the failure recorded so
 * somebody can ask for it again deliberately.
 */
export function failErasureOnExhaustion(deps: ErasureDeps): ExhaustedHandler {
  return async (event) => {
    if (event.record_id === null) return;
    const requestId = event.record_id;
    await withTenant(deps.db, { tenantId: event.tenant_id, userId: null }, (tx) =>
      fail(tx, event.tenant_id, requestId, GENERIC_FAILURE),
    );
  };
}

const GENERIC_FAILURE =
  'The erasure could not be completed. It has been stopped; ask for it again to retry.';
