import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  ConflictError,
  EMAIL_TEMPLATES_PER_TENANT_MAX,
  newId,
  NotFoundError,
  VersionConflictError,
  type Actor,
} from '@crm/core';
import type {
  EmailSignature,
  EmailSignatureUpdateInput,
  EmailTemplate,
  EmailTemplateCreateInput,
  EmailTemplateUpdateInput,
} from '@crm/contracts';
import type { EmailTemplateRow, Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { EmailsRepository } from './emails.repository.js';

const NAME_TAKEN = 'email_templates_tenant_name_key';

/**
 * Email templates and each person's signature (ADR-0074).
 *
 * **Templates are company-wide configuration.** Anyone who may send can read them (the Send dialog
 * offers them); changing them needs `update` on `tenant_settings`, the grant that guards the sender
 * settings, so no new permission and no backfill. They are plain text with merge fields from a closed
 * list; a field that is not on it cannot be saved, and an email already sent holds its own words, so
 * changing or removing a template never changes one.
 *
 * **A signature is one person's own.** The person is taken from the session, never from the request, so
 * nobody can read or write another's. Sending needs `email_message:create`, and so does having a
 * signature.
 */
@Injectable()
export class EmailTemplatesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmailsRepository) private readonly repository: EmailsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  // ---- templates ---------------------------------------------------------------------------------------

  async list(actor: Actor): Promise<EmailTemplate[]> {
    assertCan(actor, 'create', { objectType: 'email_message' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      return (await this.repository.listTemplates(tx, actor.tenantId)).map(toDto);
    });
  }

  async create(actor: Actor, input: EmailTemplateCreateInput): Promise<EmailTemplate> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      if (
        (await this.repository.countTemplates(tx, actor.tenantId)) >= EMAIL_TEMPLATES_PER_TENANT_MAX
      ) {
        throw new ConflictError(
          `A company can have at most ${String(EMAIL_TEMPLATES_PER_TENANT_MAX)} email templates`,
        );
      }
      let row: EmailTemplateRow;
      try {
        row = await tx.transaction((savepoint) =>
          this.repository.insertTemplate(savepoint, {
            id: newId(),
            tenantId: actor.tenantId,
            name: input.name,
            subject: input.subject,
            bodyText: input.body,
            version: 1,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          }),
        );
      } catch (error) {
        if (isConstraintViolation(error, NAME_TAKEN)) throw nameTaken();
        throw error;
      }
      await this.record(tx, actor, 'create', row.id, 'created', { name: { new: row.name } });
      return toDto(row);
    });
  }

  async update(actor: Actor, id: string, input: EmailTemplateUpdateInput): Promise<EmailTemplate> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const existing = await this.repository.findTemplate(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Email template');
      if (existing.version !== input.version) throw new VersionConflictError('email template');

      let updated: EmailTemplateRow | null;
      try {
        updated = await tx.transaction((savepoint) =>
          this.repository.updateTemplate(savepoint, {
            tenantId: actor.tenantId,
            id,
            version: input.version,
            userId: actor.userId,
            patch: {
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.subject === undefined ? {} : { subject: input.subject }),
              ...(input.body === undefined ? {} : { bodyText: input.body }),
            },
          }),
        );
      } catch (error) {
        if (isConstraintViolation(error, NAME_TAKEN)) throw nameTaken();
        throw error;
      }
      if (updated === null) throw new VersionConflictError('email template');

      const changes: Record<string, { old?: unknown; new?: unknown }> = {};
      if (updated.name !== existing.name)
        changes['name'] = { old: existing.name, new: updated.name };
      if (updated.subject !== existing.subject) changes['subject'] = { new: 'changed' };
      if (updated.bodyText !== existing.bodyText) changes['body'] = { new: 'changed' };
      await this.record(tx, actor, 'update', id, 'updated', changes);
      return toDto(updated);
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });
    await this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const existing = await this.repository.findTemplate(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Email template');
      if (existing.version !== version) throw new VersionConflictError('email template');
      const removed = await this.repository.softDeleteTemplate(tx, {
        tenantId: actor.tenantId,
        id,
        version,
        userId: actor.userId,
      });
      if (!removed) throw new VersionConflictError('email template');
      await this.record(tx, actor, 'delete', id, 'deleted', { name: { old: existing.name } });
    });
  }

  // ---- the person's own signature -------------------------------------------------------------------

  async getSignature(actor: Actor): Promise<EmailSignature> {
    assertCan(actor, 'create', { objectType: 'email_message' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const row = await this.repository.findSignature(tx, actor.tenantId, actor.userId);
      return { text: row?.signatureText ?? '', version: row?.version ?? null };
    });
  }

  async saveSignature(actor: Actor, input: EmailSignatureUpdateInput): Promise<EmailSignature> {
    assertCan(actor, 'create', { objectType: 'email_message' });
    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'email');
      const existing = await this.repository.findSignature(tx, actor.tenantId, actor.userId);

      let saved;
      if (existing === null) {
        // The first save has no version to send; a client that sent one read something that is gone.
        if (input.version !== undefined) throw new VersionConflictError('signature');
        saved = await this.repository.insertSignature(tx, {
          id: newId(),
          tenantId: actor.tenantId,
          userId: actor.userId,
          signatureText: input.text,
          version: 1,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      } else {
        if (input.version === undefined || input.version !== existing.version) {
          throw new VersionConflictError('signature');
        }
        saved = await this.repository.updateSignature(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          version: input.version,
          text: input.text,
        });
      }
      if (saved === null) throw new VersionConflictError('signature');

      // The words are the person's own and may hold a phone number: the audit entry says they changed.
      await this.audit.record(tx, actor, {
        action: existing === null ? 'create' : 'update',
        objectType: 'email_signature',
        recordId: saved.id,
        changes: { signature: { new: input.text.trim() === '' ? 'cleared' : 'changed' } },
      });
      return { text: saved.signatureText, version: saved.version };
    });
  }

  // ---- shared ----------------------------------------------------------------------------------------

  private async record(
    tx: Tx,
    actor: Actor,
    action: 'create' | 'update' | 'delete',
    id: string,
    verb: 'created' | 'updated' | 'deleted',
    changes: Record<string, { old?: unknown; new?: unknown }>,
  ): Promise<void> {
    await this.audit.record(tx, actor, {
      action,
      objectType: 'email_template',
      recordId: id,
      changes,
    });
    await this.outbox.publish(tx, actor, {
      eventType: `email_template.${verb}.v1`,
      objectType: 'email_template',
      recordId: id,
      payload: { changedFields: Object.keys(changes) },
    });
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function nameTaken(): ConflictError {
  return new ConflictError('A template with that name already exists');
}

function toDto(row: EmailTemplateRow): EmailTemplate {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.bodyText,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
