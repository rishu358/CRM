import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  assertCan,
  callingCodeForLocale,
  checkFormFields,
  isAllowedRedirect,
  isHttpsUrl,
  newId,
  normalizeOrigins,
  offerableFormFields,
  type Actor,
  type ErrorDetail,
  type FieldDefinition,
} from '@crm/core';
import { formKeyHint, generateFormKey, hashFormKey } from '@crm/core/lead-form-token';
import type {
  LeadForm,
  LeadFormCreateInput,
  LeadFormIssued,
  LeadFormRevokeInput,
  LeadFormRotateInput,
  LeadFormSetup,
  LeadFormUpdateInput,
} from '@crm/contracts';
import type { LeadFormKeyRow, LeadFormRow, Tx } from '@crm/db';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService, diffChanges } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { formLink, formSnippet } from './lead-form-links.js';
import { LeadFormsRepository, type FormStats } from './lead-forms.repository.js';

const NO_STATS: FormStats = { today: 0, last7Days: 0, total: 0, lastSubmittedAt: null };

/** What an audit entry says about a form: names and counts, never a key, never the consent wording. */
function auditView(row: LeadFormRow): Record<string, unknown> {
  return {
    name: row.name,
    status: row.status,
    fields: row.fields.map((field) => `${field.key}${field.required ? '*' : ''}`).join(','),
    consentVersion: row.consentVersion,
    privacyUrl: row.privacyUrl,
    successRedirectUrl: row.successRedirectUrl,
    allowedOrigins: row.allowedOrigins.join(','),
    phoneCountryCode: row.phoneCountryCode,
  };
}

function serialize(row: LeadFormRow, keys: readonly LeadFormKeyRow[], stats: FormStats): LeadForm {
  const newest = keys[0];
  const retiring = keys.find((key) => key.retiresAt !== null);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    fields: row.fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      ...(field.helpText === undefined ? {} : { helpText: field.helpText }),
    })),
    consentText: row.consentText,
    consentVersion: row.consentVersion,
    privacyUrl: row.privacyUrl,
    successMessage: row.successMessage,
    successRedirectUrl: row.successRedirectUrl,
    allowedOrigins: [...row.allowedOrigins],
    phoneCountryCode: row.phoneCountryCode,
    keyHint: newest?.hint ?? null,
    previousKeyRetiresAt: retiring?.retiresAt?.toISOString() ?? null,
    stats: {
      today: stats.today,
      last7Days: stats.last7Days,
      total: stats.total,
      lastSubmittedAt: stats.lastSubmittedAt?.toISOString() ?? null,
    },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Website lead forms: the administration side (ADR-0063).
 *
 * The same five steps every module follows: authorize with `can()` against the `lead_form` object
 * before anything else, check the rules, write with the audit entry and the outbox event in ONE
 * transaction, answer with the form as the editor now sees it.
 *
 * **Keys.** A key is made here and shown once, in the answer to the request that made it: only its
 * SHA-256 is stored, so no later call can show it again, and neither an audit entry nor an event ever
 * carries one. Rotation adds a key and lets the older one run out after a grace window; at most two
 * keys are ever live.
 *
 * A form that is not in the caller's company is a 404, exactly like one that does not exist.
 */
@Injectable()
export class LeadFormsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LeadFormsRepository) private readonly repository: LeadFormsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async setup(actor: Actor): Promise<LeadFormSetup> {
    assertCan(actor, 'read', { objectType: 'lead_form' });
    return this.inTenant(actor, (tx) => this.setupInTx(actor, tx));
  }

  async list(actor: Actor): Promise<LeadForm[]> {
    assertCan(actor, 'read', { objectType: 'lead_form' });

    return this.inTenant(actor, async (tx) => {
      const forms = await this.repository.list(tx, actor.tenantId);
      const ids = forms.map((form) => form.id);
      const [keys, stats] = await Promise.all([
        this.repository.liveKeys(tx, actor.tenantId, ids),
        this.repository.stats(tx, actor.tenantId, ids),
      ]);
      return forms.map((form) =>
        serialize(
          form,
          keys.filter((key) => key.formId === form.id),
          stats.get(form.id) ?? NO_STATS,
        ),
      );
    });
  }

  async getById(actor: Actor, id: string): Promise<LeadForm> {
    assertCan(actor, 'read', { objectType: 'lead_form' });
    return this.inTenant(actor, async (tx) => {
      const row = await this.repository.findById(tx, actor.tenantId, id);
      if (row === null) throw new NotFoundError('Form');
      return this.view(tx, actor.tenantId, row);
    });
  }

  // -------------------------------------------------------------------------
  // The kill switch
  // -------------------------------------------------------------------------

  async pause(actor: Actor, paused: boolean): Promise<LeadFormSetup> {
    assertCan(actor, 'update', { objectType: 'lead_form' });

    return this.inTenant(actor, async (tx) => {
      const was = await this.repository.isPaused(tx, actor.tenantId);
      if (was !== paused) {
        await this.repository.setPaused(tx, actor.tenantId, paused);
        await this.audit.record(tx, actor, {
          action: 'update',
          objectType: 'lead_form',
          recordId: null,
          changes: { paused: { old: was, new: paused } },
        });
        // The event is about the workspace's forms as a whole, so its record is the workspace.
        await this.outbox.publish(tx, actor, {
          eventType: paused ? 'lead_forms.paused.v1' : 'lead_forms.resumed.v1',
          objectType: 'lead_form',
          recordId: actor.tenantId,
        });
      }
      return this.setupInTx(actor, tx);
    });
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(actor: Actor, input: LeadFormCreateInput): Promise<LeadFormIssued> {
    assertCan(actor, 'create', { objectType: 'lead_form' });

    return this.inTenant(actor, async (tx) => {
      await this.entitlements.require(tx, actor.tenantId, 'web_forms');

      if ((await this.repository.count(tx, actor.tenantId)) >= this.env.LEAD_FORMS_MAX_PER_TENANT) {
        throw new ConflictError(
          `A workspace can have at most ${this.env.LEAD_FORMS_MAX_PER_TENANT} web forms`,
        );
      }

      const definitions = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');
      const origins = this.checkRules({
        fields: input.fields,
        allowedOrigins: input.allowedOrigins,
        privacyUrl: input.privacyUrl ?? null,
        successRedirectUrl: input.successRedirectUrl ?? null,
        definitions,
        checkFields: true,
      });

      let row: LeadFormRow;
      try {
        row = await this.repository.insert(tx, {
          id: newId(),
          tenantId: actor.tenantId,
          name: input.name,
          status: 'enabled',
          fields: input.fields,
          consentText: input.consentText,
          consentVersion: 1,
          privacyUrl: input.privacyUrl ?? null,
          successMessage: input.successMessage,
          successRedirectUrl: input.successRedirectUrl ?? null,
          allowedOrigins: origins,
          phoneCountryCode: input.phoneCountryCode ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      } catch (error) {
        if (isConstraintViolation(error, 'lead_forms_tenant_name_key')) throw nameTaken();
        throw error;
      }

      await this.repository.insertConsentText(tx, {
        id: newId(),
        tenantId: actor.tenantId,
        formId: row.id,
        version: 1,
        text: row.consentText,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      const issued = await this.issueKey(tx, actor, row.id);

      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'lead_form',
        recordId: row.id,
        changes: diffChanges({}, auditView(row)),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_form.created.v1',
        objectType: 'lead_form',
        recordId: row.id,
      });

      return this.issued(tx, actor.tenantId, row, issued);
    });
  }

  async update(actor: Actor, id: string, input: LeadFormUpdateInput): Promise<LeadForm> {
    assertCan(actor, 'update', { objectType: 'lead_form' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.lockById(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Form');
      if (existing.version !== input.version) throw new VersionConflictError('form');

      const patch: Partial<typeof existing> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.status !== undefined) patch.status = input.status;
      if (input.successMessage !== undefined) patch.successMessage = input.successMessage;
      if (input.phoneCountryCode !== undefined) patch.phoneCountryCode = input.phoneCountryCode;

      const touchesRules =
        input.fields !== undefined ||
        input.allowedOrigins !== undefined ||
        input.privacyUrl !== undefined ||
        input.successRedirectUrl !== undefined;
      if (touchesRules) {
        const definitions = await this.fieldMetadata.forObject(tx, actor.tenantId, 'lead');
        const fields = input.fields ?? existing.fields;
        const origins = this.checkRules({
          fields,
          allowedOrigins: input.allowedOrigins ?? existing.allowedOrigins,
          privacyUrl: input.privacyUrl === undefined ? existing.privacyUrl : input.privacyUrl,
          successRedirectUrl:
            input.successRedirectUrl === undefined
              ? existing.successRedirectUrl
              : input.successRedirectUrl,
          definitions,
          checkFields: input.fields !== undefined,
        });
        if (input.fields !== undefined) patch.fields = input.fields;
        if (input.allowedOrigins !== undefined) patch.allowedOrigins = origins;
        if (input.privacyUrl !== undefined) patch.privacyUrl = input.privacyUrl;
        if (input.successRedirectUrl !== undefined)
          patch.successRedirectUrl = input.successRedirectUrl;
      }

      // New wording is a new version, and the old wording stays on record: a lead says which version
      // its visitor accepted, and that has to remain answerable.
      const consentChanged =
        input.consentText !== undefined && input.consentText !== existing.consentText;
      if (consentChanged && input.consentText !== undefined) {
        patch.consentText = input.consentText;
        patch.consentVersion = existing.consentVersion + 1;
      }

      let row: LeadFormRow;
      try {
        row = await this.repository.update(tx, actor.tenantId, id, patch, actor.userId);
      } catch (error) {
        if (isConstraintViolation(error, 'lead_forms_tenant_name_key')) throw nameTaken();
        throw error;
      }

      if (consentChanged) {
        await this.repository.insertConsentText(tx, {
          id: newId(),
          tenantId: actor.tenantId,
          formId: id,
          version: row.consentVersion,
          text: row.consentText,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      }

      const changes = diffChanges(auditView(existing), auditView(row));
      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead_form',
        recordId: id,
        changes,
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_form.updated.v1',
        objectType: 'lead_form',
        recordId: id,
        payload: { changedFields: Object.keys(changes) },
      });
      if (existing.status !== row.status) {
        await this.outbox.publish(tx, actor, {
          eventType: row.status === 'enabled' ? 'lead_form.enabled.v1' : 'lead_form.disabled.v1',
          objectType: 'lead_form',
          recordId: id,
        });
      }

      return this.view(tx, actor.tenantId, row);
    });
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    assertCan(actor, 'delete', { objectType: 'lead_form' });

    await this.inTenant(actor, async (tx) => {
      const existing = await this.repository.lockById(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Form');
      if (existing.version !== version) throw new VersionConflictError('form');

      await this.repository.revokeAllKeys(tx, actor.tenantId, id, actor.userId);
      await this.repository.softDelete(tx, actor.tenantId, id, actor.userId);

      await this.audit.record(tx, actor, {
        action: 'delete',
        objectType: 'lead_form',
        recordId: id,
        changes: diffChanges(auditView(existing), {}),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_form.deleted.v1',
        objectType: 'lead_form',
        recordId: id,
      });
    });
  }

  async rotateKey(actor: Actor, id: string, input: LeadFormRotateInput): Promise<LeadFormIssued> {
    assertCan(actor, 'update', { objectType: 'lead_form' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.lockById(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Form');
      if (existing.version !== input.version) throw new VersionConflictError('form');

      // At most two keys are ever live: the newest keeps working for the grace window, and anything
      // older than that stops now.
      const live = await this.repository.liveKeys(tx, actor.tenantId, [id]);
      const [newest, ...older] = live;
      await this.repository.retireKeys(
        tx,
        actor.tenantId,
        older.map((key) => key.id),
        0,
        actor.userId,
      );
      if (newest !== undefined) {
        await this.repository.retireKeys(
          tx,
          actor.tenantId,
          [newest.id],
          input.graceHours * 3600,
          actor.userId,
        );
      }

      const issued = await this.issueKey(tx, actor, id);
      const row = await this.repository.update(tx, actor.tenantId, id, {}, actor.userId);

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead_form',
        recordId: id,
        // Says that a key was issued and how long the old one runs on. Never the key, never its digest.
        changes: {
          key: { old: newest?.hint ?? null, new: formKeyHint(issued.key) },
          graceHours: { new: input.graceHours },
        },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_form.key_rotated.v1',
        objectType: 'lead_form',
        recordId: id,
        payload: { graceHours: input.graceHours },
      });

      return this.issued(tx, actor.tenantId, row, issued);
    });
  }

  async revokeKeys(actor: Actor, id: string, input: LeadFormRevokeInput): Promise<LeadForm> {
    assertCan(actor, 'update', { objectType: 'lead_form' });

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.lockById(tx, actor.tenantId, id);
      if (existing === null) throw new NotFoundError('Form');
      if (existing.version !== input.version) throw new VersionConflictError('form');

      await this.repository.revokeAllKeys(tx, actor.tenantId, id, actor.userId);
      const row = await this.repository.update(tx, actor.tenantId, id, {}, actor.userId);

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'lead_form',
        recordId: id,
        changes: { key: { new: 'revoked' } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'lead_form.key_revoked.v1',
        objectType: 'lead_form',
        recordId: id,
      });

      return this.view(tx, actor.tenantId, row);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async setupInTx(actor: Actor, tx: Tx): Promise<LeadFormSetup> {
    const [definitions, paused, locale] = await Promise.all([
      this.fieldMetadata.forObject(tx, actor.tenantId, 'lead'),
      this.repository.isPaused(tx, actor.tenantId),
      this.repository.locale(tx, actor.tenantId),
    ]);
    return {
      fields: offerableFormFields(definitions).map((definition) => ({
        key: definition.key,
        label: definition.label,
        type: definition.type,
        mandatory: definition.key === 'last_name',
        ...(definition.options === undefined
          ? {}
          : {
              options: definition.options
                .filter((option) => option.isActive !== false)
                .map((option) => ({ value: option.value, label: option.label })),
            }),
      })),
      paused,
      defaultPhoneCountryCode: locale === null ? null : callingCodeForLocale(locale),
      maxForms: this.env.LEAD_FORMS_MAX_PER_TENANT,
    };
  }

  /** Make a key, keep its digest, and hand the key back to be shown once. */
  private async issueKey(tx: Tx, actor: Actor, formId: string): Promise<{ key: string }> {
    const key = generateFormKey();
    await this.repository.insertKey(tx, {
      id: newId(),
      tenantId: actor.tenantId,
      formId,
      keyHash: hashFormKey(key),
      hint: formKeyHint(key),
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
    return { key };
  }

  private async issued(
    tx: Tx,
    tenantId: string,
    row: LeadFormRow,
    issued: { key: string },
  ): Promise<LeadFormIssued> {
    const link = formLink(this.env.PUBLIC_FORMS_BASE_URL ?? this.env.WEB_URL, issued.key);
    return {
      form: await this.view(tx, tenantId, row),
      key: issued.key,
      link,
      snippet: formSnippet(link, row.name),
    };
  }

  private async view(tx: Tx, tenantId: string, row: LeadFormRow): Promise<LeadForm> {
    const [keys, stats] = await Promise.all([
      this.repository.liveKeys(tx, tenantId, [row.id]),
      this.repository.stats(tx, tenantId, [row.id]),
    ]);
    return serialize(row, keys, stats.get(row.id) ?? NO_STATS);
  }

  /**
   * The rules a form's settings must satisfy, as one 422. Returns the origins in their normal form.
   *
   * `checkFields` is off when an edit does not touch the fields, so that switching a form off, or
   * renaming it, is never refused because the workspace has since made some other field required.
   */
  private checkRules(settings: {
    readonly fields: readonly {
      key: string;
      label: string;
      required: boolean;
      helpText?: string | undefined;
    }[];
    readonly allowedOrigins: readonly string[];
    readonly privacyUrl: string | null;
    readonly successRedirectUrl: string | null;
    readonly definitions: readonly FieldDefinition[];
    readonly checkFields: boolean;
  }): string[] {
    const issues: ErrorDetail[] = [];

    if (settings.checkFields) {
      issues.push(...checkFormFields(settings.fields, settings.definitions));
    }

    const normalised = normalizeOrigins(settings.allowedOrigins, {
      allowLocal: this.env.NODE_ENV !== 'production',
    });
    for (const index of normalised.invalid) {
      issues.push({
        path: `allowedOrigins.${index}`,
        message: 'Use an https address of the form https://www.example.com, with no path',
      });
    }

    if (settings.privacyUrl !== null && !isHttpsUrl(settings.privacyUrl)) {
      issues.push({ path: 'privacyUrl', message: 'Use an https address' });
    }
    if (
      settings.successRedirectUrl !== null &&
      !isAllowedRedirect(settings.successRedirectUrl, normalised.origins)
    ) {
      issues.push({
        path: 'successRedirectUrl',
        message: "Use an https page on one of this form's allowed websites",
      });
    }

    if (issues.length > 0) throw new ValidationError(issues);
    return normalised.origins;
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function nameTaken(): ConflictError {
  return new ConflictError('A form with that name already exists', [
    { path: 'name', message: 'A form with that name already exists' },
  ]);
}
