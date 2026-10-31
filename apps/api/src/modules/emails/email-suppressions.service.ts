import { Inject, Injectable } from '@nestjs/common';
import { assertCan, ConflictError, NotFoundError, type Actor } from '@crm/core';
import type { EmailSuppression } from '@crm/contracts';
import type { Tx } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { EmailsRepository } from './emails.repository.js';

/**
 * The addresses a company's email is not written to, and the pause (ADR-0075).
 *
 * Both are written by the worker from what the mail service reports. People only look, and end them:
 * company-wide configuration, so `tenant_settings` (read to look, update to change), the grant that already
 * guards the sender settings, with no new permission and no backfill.
 *
 * **Only a block caused by a permanent bounce can be lifted**, after the address has been corrected. A
 * complaint or an unsubscribe is the person's own refusal; the service says 409 and the database refuses
 * it too (a CHECK on the table), so a bug here cannot undo someone's "stop".
 */
@Injectable()
export class EmailSuppressionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmailsRepository) private readonly repository: EmailsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  async list(actor: Actor): Promise<EmailSuppression[]> {
    assertCan(actor, 'read', { objectType: 'tenant_settings' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const listed = await this.repository.listLiveSuppressions(tx, actor.tenantId);
      return listed.map(({ row, address }) => ({
        id: row.id,
        address,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
        liftable: row.reason === 'hard_bounce',
      }));
    });
  }

  async lift(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    await this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const row = await this.repository.findSuppression(tx, actor.tenantId, id);
      if (row === null || row.liftedAt !== null) throw new NotFoundError('Blocked address');
      if (row.reason !== 'hard_bounce') {
        throw new ConflictError(
          'This address asked not to be written to, and that cannot be undone from here',
        );
      }
      if (
        !(await this.repository.liftSuppression(tx, {
          tenantId: actor.tenantId,
          id,
          userId: actor.userId,
        }))
      ) {
        throw new NotFoundError('Blocked address');
      }
      // The audit entry names the block and why, never the address.
      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'email_suppression',
        recordId: id,
        changes: { lifted: { old: false, new: true }, reason: { old: row.reason } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'email_suppression.lifted.v1',
        objectType: 'email_suppression',
        recordId: id,
        payload: { reason: row.reason },
      });
    });
  }

  async resume(actor: Actor): Promise<void> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    await this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const pause = await this.repository.findLivePause(tx, actor.tenantId);
      if (pause === null) throw new ConflictError('Email is not paused');
      if (
        !(await this.repository.resumePause(tx, { tenantId: actor.tenantId, userId: actor.userId }))
      ) {
        throw new ConflictError('Email is not paused');
      }
      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'email_pause',
        recordId: pause.id,
        changes: { paused: { old: true, new: false }, reason: { old: pause.reason } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'email_pause.resumed.v1',
        objectType: 'email_pause',
        recordId: pause.id,
        payload: { reason: pause.reason },
      });
    });
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
