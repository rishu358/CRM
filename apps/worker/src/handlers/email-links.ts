import { newId } from '@crm/core';
import { and, emailMessageLinks, eq, type Tx } from '@crm/db';
import type { EventHandler, OutboxRow } from '../relay.js';

/**
 * When a lead is converted, its emails follow it (ADR-0074).
 *
 * The lead stays a record in its own right, so its emails stay linked to it. What changes is that the
 * person it became (the contact) and the deal it opened, if any, now show those emails too: whoever
 * can read the new contact sees what was written to them before they were a customer. Only links are
 * added; no message is read or changed, and nothing is sent.
 *
 * Idempotent, as every handler must be: delivery is at least once, and the unique index on a
 * message's links makes a second run add nothing.
 */
export function linkLeadEmailsOnConversion(): EventHandler {
  return async (tx: Tx, event: OutboxRow): Promise<void> => {
    if (event.record_id === null) return;
    const targets: { objectType: 'contact' | 'deal'; recordId: string }[] = [];
    const contactId = event.payload['contactId'];
    const dealId = event.payload['dealId'];
    if (typeof contactId === 'string') targets.push({ objectType: 'contact', recordId: contactId });
    if (typeof dealId === 'string') targets.push({ objectType: 'deal', recordId: dealId });
    if (targets.length === 0) return;

    const messages = await tx
      .select({ id: emailMessageLinks.emailMessageId })
      .from(emailMessageLinks)
      .where(
        and(
          eq(emailMessageLinks.tenantId, event.tenant_id),
          eq(emailMessageLinks.objectType, 'lead'),
          eq(emailMessageLinks.recordId, event.record_id),
        ),
      );
    if (messages.length === 0) return;

    await tx
      .insert(emailMessageLinks)
      .values(
        messages.flatMap((message) =>
          targets.map((target) => ({
            id: newId(),
            tenantId: event.tenant_id,
            emailMessageId: message.id,
            objectType: target.objectType,
            recordId: target.recordId,
            createdBy: event.actor_id,
            updatedBy: event.actor_id,
          })),
        ),
      )
      .onConflictDoNothing({
        target: [
          emailMessageLinks.tenantId,
          emailMessageLinks.emailMessageId,
          emailMessageLinks.objectType,
          emailMessageLinks.recordId,
        ],
      });
  };
}
