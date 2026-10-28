import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  EntitlementRequiredError,
  FormExpiredError,
  HONEYPOT_FIELD,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  buildSubmissionSchema,
  isFormKeyShape,
  isFormOfferable,
  newId,
  splitSubmission,
  toPublicIssues,
  type FieldDefinition,
  type FormFieldSetting,
} from '@crm/core';
import {
  checkFillToken,
  deriveFillTokenSecret,
  hashFormKey,
  hashSubmissionKey,
  issueFillToken,
} from '@crm/core/lead-form-token';
import type { PublicFormDefinition, PublicSubmissionResult } from '@crm/contracts';
import type { LeadFormRow, Tx } from '@crm/db';
import { API_ENV_TOKEN, type ApiEnv } from '../../config/env.js';
import { isConstraintViolation } from '../../common/db-errors.js';
import { withoutNetworkIdentity } from '../../common/request-context.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import {
  RATE_LIMIT_COUNTER,
  rateLimitKey,
  type RateLimitCounter,
  type RateLimitKind,
} from '../../platform/rate-limit/counter.js';
import { LeadsService } from '../leads/leads.service.js';
import { LEAD_ASSIGNER, type LeadAssigner } from './lead-assigner.js';
import { LeadFormsRepository } from './lead-forms.repository.js';

/** Every accepted outcome answers exactly this, so the answer never says what happened inside. */
const RECEIVED: PublicSubmissionResult = { received: true };

/** The window of the per-workspace limit, fixed (the other windows are configuration). */
const TENANT_WINDOW_SECONDS = 3600;
/** The same address and the same person, twice inside this long, is one submission. */
const REPEAT_WINDOW_SECONDS = 60;

interface Limit {
  readonly kind: RateLimitKind;
  readonly subject: string;
  readonly windowSeconds: number;
  readonly max: number;
}

/** The answer for every key that does not work, whatever the reason (ADR-0063 3.4). */
function notAvailable(): NotFoundError {
  return new NotFoundError('Form');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The fields a visitor is actually asked for: the form's own, minus any whose field has gone. */
function effectiveFields(
  form: LeadFormRow,
  definitions: readonly FieldDefinition[],
): { settings: FormFieldSetting[]; definitions: FieldDefinition[] } {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const settings: FormFieldSetting[] = [];
  const used: FieldDefinition[] = [];
  for (const field of form.fields) {
    const definition = byKey.get(field.key);
    if (definition === undefined || !isFormOfferable(definition)) continue;
    settings.push(field);
    used.push(definition);
  }
  return { settings, definitions: used };
}

/**
 * The public door of a website lead form (ADR-0063), the only code in the API that a stranger reaches.
 *
 * Read the ADR's section 3 before changing it. The shape of it is:
 *
 *   1. the key (a path parameter) is checked for shape, then turned into a workspace and a form by
 *      one narrow read as `crm_auth`; **nothing the caller sends can name a workspace or a user**;
 *   2. everything after that runs as `crm_app` inside that workspace's transaction, under row-level
 *      security, with no user;
 *   3. every way a key can fail to work (unknown, revoked, retired, a disabled or deleted form, a
 *      paused workspace, a suspended one, a withdrawn feature) is the same 404;
 *   4. the limits spend from their own counters, never the staff's, and the daily caps are counted in
 *      the database so they hold without Redis;
 *   5. what is stored is the lead and a consent record. No address, no user agent, no copy of the
 *      values (the audit entry's network fields are cleared for these requests).
 *
 * It reaches the leads module through two service methods that take no actor (a stranger has none),
 * and reaches no other module's repository or table; a test reads this file's imports to keep it so.
 */
@Injectable()
export class PublicLeadFormsService {
  private readonly secret: Buffer;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LeadFormsRepository) private readonly repository: LeadFormsRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(LEAD_ASSIGNER) private readonly assigner: LeadAssigner,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RATE_LIMIT_COUNTER) private readonly counter: RateLimitCounter,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {
    this.secret = deriveFillTokenSecret(env.AUTH_SECRET);
  }

  // -------------------------------------------------------------------------
  // What the hosted page draws
  // -------------------------------------------------------------------------

  async definition(key: string, address: string): Promise<PublicFormDefinition> {
    const { tenantId, formId } = await this.route(key, address);
    await this.spend([
      {
        kind: 'public-view-form',
        subject: formId,
        windowSeconds: this.env.PUBLIC_FORM_RATE_WINDOW_SECONDS,
        max: this.env.PUBLIC_FORM_RATE_VIEWS_PER_FORM,
      },
    ]);

    return this.database.runInTenant({ tenantId, userId: null }, async (tx) => {
      const { form, definitions } = await this.load(tx, tenantId, formId);
      const effective = effectiveFields(form, definitions);
      const byKey = new Map(
        effective.definitions.map((definition) => [definition.key, definition]),
      );

      return {
        name: form.name,
        fields: effective.settings.map((setting) => {
          const definition = byKey.get(setting.key);
          const options = definition?.options
            ?.filter((option) => option.isActive !== false)
            .map((option) => ({ value: option.value, label: option.label }));
          return {
            key: setting.key,
            label: setting.label,
            type: definition?.type ?? 'text',
            required: setting.required,
            helpText: setting.helpText ?? null,
            ...(options === undefined ? {} : { options }),
          };
        }),
        consentText: form.consentText,
        privacyUrl: form.privacyUrl,
        successMessage: form.successMessage,
        successRedirectUrl: form.successRedirectUrl,
        allowedOrigins: [...form.allowedOrigins],
        fillToken: issueFillToken(this.secret, form.id, new Date()),
      };
    });
  }

  // -------------------------------------------------------------------------
  // A submission
  // -------------------------------------------------------------------------

  async submit(input: {
    readonly key: string;
    readonly address: string;
    readonly body: unknown;
    readonly idempotencyKey: string | undefined;
  }): Promise<PublicSubmissionResult> {
    const { tenantId, formId } = await this.route(input.key, input.address);
    await this.spend([
      {
        kind: 'public-form-address',
        subject: `${formId}:${input.address}`,
        windowSeconds: this.env.PUBLIC_FORM_RATE_WINDOW_SECONDS,
        max: this.env.PUBLIC_FORM_RATE_PER_ADDRESS_FORM,
      },
      {
        kind: 'public-address',
        subject: input.address,
        windowSeconds: this.env.PUBLIC_FORM_RATE_WINDOW_SECONDS,
        max: this.env.PUBLIC_FORM_RATE_PER_ADDRESS,
      },
      {
        kind: 'public-form',
        subject: formId,
        windowSeconds: this.env.PUBLIC_FORM_RATE_WINDOW_SECONDS,
        max: this.env.PUBLIC_FORM_RATE_PER_FORM,
      },
      {
        kind: 'public-tenant',
        subject: tenantId,
        windowSeconds: TENANT_WINDOW_SECONDS,
        max: this.env.PUBLIC_FORM_RATE_PER_TENANT_HOUR,
      },
    ]);

    try {
      return await withoutNetworkIdentity(() =>
        this.database.runInTenant({ tenantId, userId: null }, (tx) =>
          this.accept(tx, tenantId, formId, input.body, input.idempotencyKey),
        ),
      );
    } catch (error) {
      // Two requests with one Idempotency-Key raced and the other won: one lead exists, which is the
      // whole point of the key, and this request's answer is the same as the winner's.
      if (isConstraintViolation(error, 'lead_form_submissions_idempotency_key')) return RECEIVED;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The work of one submission, inside the workspace's transaction. */
  private async accept(
    tx: Tx,
    tenantId: string,
    formId: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<PublicSubmissionResult> {
    const { form, definitions } = await this.load(tx, tenantId, formId);
    const now = new Date();

    if (!isPlainObject(body)) {
      throw new ValidationError([{ path: '', message: 'Not valid' }]);
    }

    // A hidden field a person cannot see and a script fills in. The bot is told it worked, and nothing
    // is written: a human never loses a lead this way, because a human never fills it in.
    const trap = body[HONEYPOT_FIELD];
    if (typeof trap === 'string' && trap.length > 0) return RECEIVED;

    if (checkFillToken(this.secret, form.id, body['fillToken'], now) !== 'ok') {
      throw new FormExpiredError();
    }

    const effective = effectiveFields(form, definitions);
    const parsed = buildSubmissionSchema(
      { fields: effective.settings, phoneCountryCode: form.phoneCountryCode },
      effective.definitions,
    ).safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        toPublicIssues(
          parsed.error,
          effective.settings.map((setting) => setting.key),
        ),
      );
    }
    const values = parsed.data as Record<string, unknown>;

    const submissionKey =
      idempotencyKey === undefined ? null : hashSubmissionKey(form.id, idempotencyKey);
    if (
      submissionKey !== null &&
      (await this.repository.findSubmissionByKeyHash(tx, tenantId, form.id, submissionKey)) !== null
    ) {
      return RECEIVED;
    }

    if (await this.isRepeat(form.id, values)) return RECEIVED;

    // The hard daily caps. In this transaction, so a refused submission leaves no count behind and an
    // accepted one counts exactly once; and in the database, so they hold if Redis does not.
    const underFormCap = await this.repository.takeFromDailyCap(
      tx,
      tenantId,
      `form:${form.id}`,
      this.env.LEAD_FORM_MAX_PER_FORM_PER_DAY,
    );
    const underTenantCap =
      underFormCap &&
      (await this.repository.takeFromDailyCap(
        tx,
        tenantId,
        'tenant',
        this.env.LEAD_FORM_MAX_PER_TENANT_PER_DAY,
      ));
    if (!underFormCap || !underTenantCap) {
      throw new RateLimitedError(
        'Too many requests. Try again later.',
        secondsUntilNextUtcDay(now),
      );
    }

    const split = splitSubmission(values, effective.settings);
    const identity = { tenantId, userId: null };

    const ownerId = await this.pickOwner(tx, tenantId, form, values);

    let created;
    try {
      created = await this.leads.createFromWebFormInTx(identity, tx, {
        standard: split.standard,
        customFields: split.customFields,
        ownerId,
        formId: form.id,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        // A rule of the workspace's own (a pattern on a custom field) refused a value. Say which field
        // and nothing else: the message belongs to the company's rule, not to a stranger.
        throw new ValidationError(
          error.details.map((detail) => ({
            path: (detail.path ?? '').replace(/^customFields\./, ''),
            message: 'Not valid',
          })),
        );
      }
      throw error;
    }

    const matches =
      created.email === null && created.phone === null
        ? []
        : await this.leads.findMatchesForSystem(tx, tenantId, {
            email: created.email,
            phone: created.phone,
            excludeLeadId: created.id,
          });
    const match = matches[0];

    await this.repository.insertSubmission(tx, {
      id: newId(),
      tenantId,
      formId: form.id,
      leadId: created.id,
      consentVersion: form.consentVersion,
      consentAt: now,
      source: 'web_form',
      idempotencyHash: submissionKey,
      duplicateOfType: match?.type ?? null,
      duplicateOfId: match?.id ?? null,
      createdBy: null,
      updatedBy: null,
    });

    if (match !== undefined) {
      // Offered, never imposed (ADR-0023): the lead exists, and the people who own what it matched are
      // told. Nothing about the match reaches the visitor.
      await this.outbox.publish(tx, identity, {
        eventType: 'lead.web_form_duplicate.v1',
        objectType: 'lead',
        recordId: created.id,
        payload: {
          formId: form.id,
          matchedType: match.type,
          matchedId: match.id,
          matchedOn: match.matchedOn,
          matchedOwnerId: match.ownerId,
        },
      });
    }

    return RECEIVED;
  }

  /**
   * Who gets the lead. Run inside a savepoint, and never allowed to fail the submission: a lead that
   * arrives and goes to nobody in particular is a problem for the company to fix, and a lead that is
   * refused because a rule broke is a customer lost (ADR-0063 10).
   */
  private async pickOwner(
    tx: Tx,
    tenantId: string,
    form: LeadFormRow,
    values: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      return await tx.transaction((savepoint) =>
        this.assigner.pickOwner(savepoint, {
          tenantId,
          formId: form.id,
          formCreatedBy: form.createdBy,
          facts: { ...values, source: 'web_form', form_id: form.id },
        }),
      );
    } catch {
      await this.audit.record(
        tx,
        { tenantId, userId: null },
        {
          action: 'update',
          objectType: 'lead_form',
          recordId: form.id,
          changes: { assignment: { new: 'failed' } },
        },
      );
      return null;
    }
  }

  /**
   * The same person, to the same form, twice in a minute: the second is a double click or an
   * impatient retry, and is answered as received. Remembered by a keyed hash, never the value, and
   * forgotten with the window.
   */
  private async isRepeat(formId: string, values: Record<string, unknown>): Promise<boolean> {
    const email = typeof values['email'] === 'string' ? values['email'] : '';
    const phone = typeof values['phone'] === 'string' ? values['phone'] : '';
    if (email === '' && phone === '') return false;

    const marker = createHmac('sha256', this.secret)
      .update(`repeat:${formId}:${email}:${phone}`)
      .digest('hex')
      .slice(0, 40);
    const [hit] = await this.counter.hitMany([
      { key: rateLimitKey('public-repeat', marker), windowSeconds: REPEAT_WINDOW_SECONDS },
    ]);
    return hit !== undefined && hit.count > 1;
  }

  /** Check a key's shape, then turn it into a workspace and a form, or say the one answer. */
  private async route(key: string, address: string): Promise<{ tenantId: string; formId: string }> {
    if (!isFormKeyShape(key)) {
      await this.spendBadKey(address);
      throw notAvailable();
    }
    const routed = await this.database.runAsAuth((tx) =>
      this.repository.routeKey(tx, hashFormKey(key)),
    );
    if (routed === null) {
      await this.spendBadKey(address);
      throw notAvailable();
    }
    return routed;
  }

  /** A key that does not work spends from a tighter budget than real use does. */
  private async spendBadKey(address: string): Promise<void> {
    await this.spend([
      {
        kind: 'public-bad-key',
        subject: address,
        windowSeconds: this.env.PUBLIC_FORM_RATE_WINDOW_SECONDS,
        max: this.env.PUBLIC_FORM_RATE_BAD_KEY_PER_ADDRESS,
      },
    ]);
  }

  private async spend(limits: readonly Limit[]): Promise<void> {
    const hits = await this.counter.hitMany(
      limits.map((limit) => ({
        key: rateLimitKey(limit.kind, limit.subject),
        windowSeconds: limit.windowSeconds,
      })),
    );
    let retryAfter = 0;
    limits.forEach((limit, index) => {
      const hit = hits[index];
      if (hit !== undefined && hit.count > limit.max) {
        retryAfter = Math.max(retryAfter, hit.retryAfterSeconds);
      }
    });
    // Whose budget it is, and nothing else: not the ceiling, not what is left (ADR-0053 5).
    if (retryAfter > 0)
      throw new RateLimitedError('Too many requests. Try again shortly.', retryAfter);
  }

  /**
   * The form, if it is open for business: enabled, not deleted, its workspace not paused, and the
   * workspace entitled to web forms. Every failure is the same 404.
   */
  private async load(
    tx: Tx,
    tenantId: string,
    formId: string,
  ): Promise<{ form: LeadFormRow; definitions: FieldDefinition[] }> {
    const form = await this.repository.findById(tx, tenantId, formId);
    if (form === null || form.status !== 'enabled') throw notAvailable();
    if (await this.repository.isPaused(tx, tenantId)) throw notAvailable();
    try {
      await this.entitlements.require(tx, tenantId, 'web_forms');
    } catch (error) {
      // The public must not learn what a workspace's plan includes.
      if (error instanceof EntitlementRequiredError) throw notAvailable();
      throw error;
    }
    return { form, definitions: await this.fieldMetadata.forObject(tx, tenantId, 'lead') };
  }
}
