import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_CUSTOM_FIELDS_PER_OBJECT,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  assertCan,
  canReadField,
  diffChanges,
  isPicklistType,
  newId,
  resolveOptions,
  slugify,
  uniqueSlug,
  validateFieldValidation,
  type Actor,
  type DefinitionIssue,
  type FieldType,
  type FieldValidation,
} from '@crm/core';
import type {
  FieldCreateInput,
  FieldDefinitionView,
  FieldListQuery,
  FieldOrderInput,
  FieldUpdateInput,
} from '@crm/contracts';
import type { FieldDefinitionRow, Tx } from '@crm/db';
import { isConstraintViolation } from '../../common/db-errors.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../../platform/audit.service.js';
import { OutboxService } from '../../platform/outbox.service.js';
import { CustomizationRepository, type DefinitionPatch } from './customization.repository.js';

/**
 * Custom fields and picklists, administered (MVP_SPEC M9, ADR-0039).
 *
 * Every write here changes the shape of records that already exist, so the rules
 * are about what can **not** happen afterwards:
 *
 *   - **A key and a type never change.** Records hold values under them. The key is
 *     made from the label and is the administrator's to forget about; the database
 *     grants do not even allow the column to be written.
 *   - **Nothing is deleted.** Deactivating hides a field and stops it being written;
 *     the data stays and returns on reactivation.
 *   - **A picklist option is never removed.** Retiring one keeps it valid on the
 *     records that hold it and stops it being offered.
 *   - **Built-in fields are not edited here.** The screens that draw them have their
 *     own labels, so a relabel would be invisible; they are listed, not editable.
 *
 * Authorization: reading the list needs `read` on the object and then each field the
 * caller may read — a field hidden from a role is absent from its list, so a form
 * cannot render a box for it. Everything that writes needs `update` on
 * `tenant_settings`, the grant that already means "may change company-wide settings".
 */
@Injectable()
export class CustomizationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CustomizationRepository) private readonly repository: CustomizationRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async list(actor: Actor, query: FieldListQuery): Promise<FieldDefinitionView[]> {
    const objectType = query.objectType;
    assertCan(actor, 'read', { objectType });

    const management = query.includeInactive === true;
    // Seeing the switched-off ones is a management view.
    if (management) assertCan(actor, 'read', { objectType: 'tenant_settings' });

    return this.inTenant(actor, async (tx) => {
      const rows = await this.repository.list(tx, actor.tenantId, objectType, management);
      // A form is drawn from this, so it carries only what the caller may see. The
      // management view is about the company's configuration, not its data, and
      // shows every definition.
      const visible = management
        ? rows
        : rows.filter((row) => canReadField(actor, objectType, row.key));
      return visible.map(present);
    });
  }

  async create(actor: Actor, input: FieldCreateInput): Promise<FieldDefinitionView> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });

    const type = input.type as FieldType;
    const validation = toValidation(input.validation);
    const issues: DefinitionIssue[] = validateFieldValidation(type, validation);

    let options = undefined;
    if (isPicklistType(type)) {
      const resolved = resolveOptions(undefined, input.options ?? []);
      if (resolved.ok) options = resolved.options;
      else issues.push(...resolved.issues);
    }
    raiseIssues(issues);

    return this.inTenant(actor, async (tx) => {
      const existing = await this.repository.list(tx, actor.tenantId, input.objectType, true);
      const taken = new Set(existing.map((row) => row.key));
      const key = uniqueSlug(slugify(input.label), taken);
      const position = existing.reduce((max, row) => Math.max(max, row.position), 0) + 10;

      let row: FieldDefinitionRow;
      try {
        row = await this.repository.insert(tx, {
          id: newId(),
          tenantId: actor.tenantId,
          objectType: input.objectType,
          key,
          label: input.label,
          type,
          required: input.required ?? false,
          options: options ?? null,
          validation: validation ?? null,
          helpText: input.helpText ?? null,
          section: input.section ?? null,
          position,
          isSystem: false,
          isActive: true,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      } catch (error) {
        if (isConstraintViolation(error, 'field_definitions_custom_cap')) {
          throw new ValidationError([
            {
              path: 'objectType',
              message: `A company can have at most ${MAX_CUSTOM_FIELDS_PER_OBJECT} custom fields on one object`,
            },
          ]);
        }
        throw error;
      }

      await this.audit.record(tx, actor, {
        action: 'create',
        objectType: 'field_definition',
        recordId: row.id,
        changes: diffChanges(
          {},
          {
            objectType: row.objectType,
            key: row.key,
            label: row.label,
            type: row.type,
            required: row.required,
            section: row.section,
          },
        ),
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'field_definition.created.v1',
        objectType: 'field_definition',
        recordId: row.id,
        payload: { objectType: row.objectType, key: row.key },
      });
      return present(row);
    });
  }

  async update(actor: Actor, id: string, input: FieldUpdateInput): Promise<FieldDefinitionView> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });

    return this.inTenant(actor, async (tx) => {
      const before = await this.repository.findById(tx, actor.tenantId, id);
      if (before === null) throw new NotFoundError('Field');
      if (before.isSystem) {
        throw new ValidationError([{ path: 'id', message: 'A built-in field cannot be changed' }]);
      }
      if (before.version !== input.version) throw new VersionConflictError('field');

      const type = before.type as FieldType;
      const issues: DefinitionIssue[] = [];
      const patch: { -readonly [K in keyof DefinitionPatch]: DefinitionPatch[K] } = {};

      if (input.label !== undefined) patch.label = input.label;
      if (input.required !== undefined) patch.required = input.required;
      if (input.helpText !== undefined) patch.helpText = input.helpText;
      if (input.section !== undefined) patch.section = input.section;
      if (input.isActive !== undefined) patch.isActive = input.isActive;

      if (input.options !== undefined) {
        if (!isPicklistType(type)) {
          issues.push({ path: 'options', message: 'Only a picklist has options' });
        } else {
          const resolved = resolveOptions(before.options ?? undefined, input.options);
          if (resolved.ok) patch.options = resolved.options;
          else issues.push(...resolved.issues);
        }
      }

      if (input.validation !== undefined) {
        const validation = toValidation(input.validation);
        issues.push(...validateFieldValidation(type, validation));
        patch.validation = validation ?? null;
      }
      raiseIssues(issues);

      const after = await this.repository.update(
        tx,
        actor.tenantId,
        id,
        input.version,
        patch,
        actor.userId,
      );
      // The row exists — it was just read — so a miss means the version moved.
      if (after === null) throw new VersionConflictError('field');

      const changes = diffChanges(summary(before), summary(after));
      if (Object.keys(changes).length > 0) {
        await this.audit.record(tx, actor, {
          action: 'update',
          objectType: 'field_definition',
          recordId: id,
          changes,
        });
        await this.outbox.publish(tx, actor, {
          eventType: 'field_definition.updated.v1',
          objectType: 'field_definition',
          recordId: id,
          payload: { objectType: after.objectType, key: after.key },
        });
      }
      return present(after);
    });
  }

  /**
   * Set the order of an object's custom fields.
   *
   * Names every one of them — inactive included — or is refused: a list that left one
   * out would have to guess where it goes, and a guess is how two administrators end
   * up with fields in an order neither chose. All or nothing, in one transaction.
   */
  async order(actor: Actor, input: FieldOrderInput): Promise<FieldDefinitionView[]> {
    assertCan(actor, 'update', { objectType: 'tenant_settings' });

    return this.inTenant(actor, async (tx) => {
      const rows = await this.repository.list(tx, actor.tenantId, input.objectType, true);
      const custom = rows.filter((row) => !row.isSystem);
      const systemEnd = rows
        .filter((row) => row.isSystem)
        .reduce((m, r) => Math.max(m, r.position), 0);

      const wanted = new Set(input.ids);
      const have = new Set(custom.map((row) => row.id));
      const sameSet =
        wanted.size === input.ids.length &&
        wanted.size === have.size &&
        [...wanted].every((id) => have.has(id));
      if (!sameSet) {
        throw new ValidationError([
          {
            path: 'ids',
            message: 'List every custom field of this object exactly once',
          },
        ]);
      }

      const before = custom.map((row) => row.id);
      if (before.join() === input.ids.join()) return rows.map(present);

      for (const [index, id] of input.ids.entries()) {
        await this.repository.setPosition(
          tx,
          actor.tenantId,
          id,
          systemEnd + (index + 1) * 10,
          actor.userId,
        );
      }

      await this.audit.record(tx, actor, {
        action: 'update',
        objectType: 'field_definition',
        recordId: null,
        changes: { order: { old: before, new: [...input.ids] } },
      });
      await this.outbox.publish(tx, actor, {
        eventType: 'field_definition.reordered.v1',
        objectType: 'field_definition',
        // An ordering belongs to the object, not to one field, so it is filed under the company.
        recordId: actor.tenantId,
        payload: { objectType: input.objectType },
      });

      return (await this.repository.list(tx, actor.tenantId, input.objectType, true)).map(present);
    });
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

function raiseIssues(issues: readonly DefinitionIssue[]): void {
  if (issues.length > 0) throw new ValidationError(issues.map((i) => ({ ...i })));
}

/**
 * The submitted limits as the stored shape. Built key by key, so an `undefined` the
 * schema allows never becomes a stored key.
 */
function toValidation(input: FieldCreateInput['validation']): FieldValidation | undefined {
  if (input === undefined) return undefined;
  return {
    ...(input.minLength === undefined ? {} : { minLength: input.minLength }),
    ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
    ...(input.min === undefined ? {} : { min: input.min }),
    ...(input.max === undefined ? {} : { max: input.max }),
    ...(input.allowedCurrencies === undefined
      ? {}
      : { allowedCurrencies: input.allowedCurrencies }),
  };
}

/** What an audit entry says about a definition: what an administrator can change. */
function summary(row: FieldDefinitionRow): Record<string, unknown> {
  return {
    label: row.label,
    required: row.required,
    section: row.section,
    helpText: row.helpText,
    isActive: row.isActive,
    options: row.options,
    validation: limits(row.validation),
  };
}

/** Only the limits an administrator can set. A stored `pattern` from before M9 is not shown. */
function limits(validation: FieldValidation | null): FieldDefinitionView['validation'] {
  if (validation === null) return undefined;
  const { minLength, maxLength, min, max, allowedCurrencies } = validation;
  const shown = {
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(allowedCurrencies === undefined ? {} : { allowedCurrencies: [...allowedCurrencies] }),
  };
  return Object.keys(shown).length === 0 ? undefined : shown;
}

function present(row: FieldDefinitionRow): FieldDefinitionView {
  const validation = limits(row.validation);
  return {
    id: row.id,
    objectType: row.objectType as FieldDefinitionView['objectType'],
    key: row.key,
    label: row.label,
    type: row.type as FieldDefinitionView['type'],
    required: row.required,
    ...(row.options === null ? {} : { options: row.options.map((o) => ({ ...o })) }),
    ...(validation === undefined ? {} : { validation }),
    helpText: row.helpText,
    section: row.section,
    position: row.position,
    isSystem: row.isSystem,
    isActive: row.isActive,
    version: row.version,
  };
}
