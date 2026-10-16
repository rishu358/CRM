import { Injectable } from '@nestjs/common';
import { newId, type Actor } from '@crm/core';
import { outboxEvents, type Tx } from '@crm/db';
import { currentRequestContext } from '../common/request-context.js';

/**
 * Transactional outbox writer (ADR-0006).
 *
 * A service announces what happened by writing an event here, in the same
 * transaction as the change. It never calls search indexing, notifications,
 * webhooks or email directly — those are the worker's business, and calling
 * them inline would mean either losing the side effect on a crash or firing it
 * for a change that rolled back.
 *
 * Delivery is at-least-once, so every consumer must be idempotent.
 */
export interface DomainEvent {
  /** Dotted and versioned, e.g. `contact.created.v1`. */
  readonly eventType: string;
  readonly objectType: string;
  readonly recordId: string;
  readonly payload?: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  async publish(tx: Tx, actor: Actor, event: DomainEvent): Promise<void> {
    const context = currentRequestContext();
    await tx.insert(outboxEvents).values({
      id: newId(),
      tenantId: actor.tenantId,
      eventType: event.eventType,
      objectType: event.objectType,
      recordId: event.recordId,
      payload: event.payload ?? {},
      actorId: actor.userId,
      requestId: context?.requestId ?? null,
    });
  }
}
