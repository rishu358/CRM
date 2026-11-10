import { Inject, Injectable } from '@nestjs/common';
import { assertCan, ConflictError, newId, VersionConflictError, type Actor } from '@crm/core';
import type { EmailSettings, EmailSettingsUpdateInput } from '@crm/contracts';
import type { Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { EmailsRepository } from './emails.repository.js';
import { EmailsService } from './emails.service.js';

/**
 * The company's email sender: the name mail goes out under, where a reply goes, and a footer
 * (ADR-0073).
 *
 * Company-wide configuration, so it is `tenant_settings`: read to look, update to change, the same
 * grant tags and the company profile use, which is a row in the role matrix and needed no new
 * permission and no backfill. The address mail is sent from is not here: it is the operator's
 * (`EMAIL_OUTREACH_FROM`), and a company can never choose it.
 */
@Injectable()
export class EmailSettingsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmailsRepository) private readonly repository: EmailsRepository,
    @Inject(EmailsService) private readonly emails: EmailsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  async get(actor: Actor): Promise<EmailSettings> {
    assertCan(actor, 'read', { objectType: 'tenant_settings' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      return this.view(tx, actor);
    });
  }

  async save(actor: Actor, input: EmailSettingsUpdateInput): Promise<EmailSettings> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const existing = await this.repository.findConfig(tx, actor.tenantId);

      if (existing === null) {
        // The first save has no version to send; a client that sent one read something that is gone.
        if (input.version !== undefined) throw new VersionConflictError('email settings');
        const created = await this.insertFirst(tx, actor, input);
        if (created === null) throw new VersionConflictError('email settings');
        await this.record(tx, actor, 'create', created.id, {
          fromName: { new: input.fromName },
          replyTo: { new: input.replyTo },
          footerText: { new: input.footerText === null ? null : 'set' },
        });
      } else {
        if (input.version === undefined || input.version !== existing.version) {
          throw new VersionConflictError('email settings');
        }
        const updated = await this.repository.updateConfig(tx, {
          tenantId: actor.tenantId,
          version: input.version,
          userId: actor.userId,
          fromName: input.fromName,
          replyTo: input.replyTo,
          footerText: input.footerText,
        });
        if (updated === null) throw new VersionConflictError('email settings');
        const changes: Record<string, { old?: unknown; new?: unknown }> = {};
        if (existing.fromName !== updated.fromName) {
          changes['fromName'] = { old: existing.fromName, new: updated.fromName };
        }
        if ((existing.replyTo ?? null) !== (updated.replyTo ?? null)) {
          changes['replyTo'] = { old: existing.replyTo, new: updated.replyTo };
        }
        if ((existing.footerText ?? null) !== (updated.footerText ?? null)) {
          // The footer is the company's own words, but it can hold an address: say that it changed.
          changes['footerText'] = { new: updated.footerText === null ? null : 'changed' };
        }
        await this.record(tx, actor, 'update', updated.id, changes);
      }
      return this.view(tx, actor);
    });
  }

  private async insertFirst(tx: Tx, actor: Actor, input: EmailSettingsUpdateInput) {
    try {
      return await this.repository.insertConfig(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        fromName: input.fromName,
        replyTo: input.replyTo,
        footerText: input.footerText,
        version: 1,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
    } catch (error) {
      if (isConstraintViolation(error, 'email_sender_config_tenant_key')) {
        throw new ConflictError('The email settings were saved by someone else just now');
      }
      throw error;
    }
  }

  private async record(
    tx: Tx,
    actor: Actor,
    action: 'create' | 'update',
    id: string,
    changes: Record<string, { old?: unknown; new?: unknown }>,
  ): Promise<void> {
    await this.audit.record(tx, actor, {
      action,
      objectType: 'email_sender_config',
      recordId: id,
      changes,
    });
    await this.outbox.publish(tx, actor, {
      eventType: 'email_sender_config.updated.v1',
      objectType: 'email_sender_config',
      recordId: id,
      payload: { changedFields: Object.keys(changes) },
    });
  }

  private async view(tx: Tx, actor: Actor): Promise<EmailSettings> {
    const config = await this.repository.findConfig(tx, actor.tenantId);
    const facts = await this.repository.tenantFacts(tx, actor.tenantId);
    const sender = await this.emails.senderFor(tx, actor).catch(() => null);
    return {
      fromName: config?.fromName ?? sender?.fromName ?? facts.name,
      replyTo: config?.replyTo ?? null,
      footerText: config?.footerText ?? null,
      version: config?.version ?? null,
      sendingAddress: this.emails.sendingAddress(),
      defaultFromName: facts.name,
      usage: await this.emails.usageFor(tx, actor),
      paused: await this.pausedState(tx, actor),
    };
  }

  private async pausedState(tx: Tx, actor: Actor): Promise<EmailSettings['paused']> {
    const pause = await this.repository.findLivePause(tx, actor.tenantId);
    return pause === null ? null : { since: pause.pausedAt.toISOString(), reason: pause.reason };
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}
