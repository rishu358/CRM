import {
  BULK_EDITABLE_FIELDS,
  bulkEditableField,
  buildCustomFieldsPatchSchema,
  canWriteField,
  FieldNotWritableError,
  ValidationError,
  type Actor,
  type BusinessObjectType,
  type ErrorDetail,
  type FieldDefinition,
} from '@crm/core';
import {
  accountUpdateSchema,
  contactUpdateSchema,
  dealUpdateSchema,
  leadUpdateSchema,
} from '@crm/contracts';
import type { ZodType } from 'zod';

/**
 * Turn a bulk edit's `changes` into the object's own update input, once, before any record is
 * touched (ADR-0056).
 *
 * The same value goes to every record, so everything that does not depend on the record is
 * settled here and is a 422 for the whole request: an unknown field, a field the caller may not
 * write, a value of the wrong shape. Only what depends on the record (a lead already converted, a
 * stage from another pipeline) is left to the per-record result.
 *
 * Which system fields may be named is the allowlist in `@crm/core` (`BULK_EDITABLE_FIELDS`);
 * custom fields are whatever is active in this tenant's metadata, written through the same
 * schema a single edit uses. Values go through the object's update schema last, so a phone number
 * or a date is held to exactly what `PATCH` holds it to.
 */

const UPDATE_SCHEMAS: Readonly<Record<BusinessObjectType, ZodType>> = {
  contact: contactUpdateSchema.omit({ version: true }),
  account: accountUpdateSchema.omit({ version: true }),
  lead: leadUpdateSchema.omit({ version: true }),
  deal: dealUpdateSchema.omit({ version: true }),
};

export function buildBulkPatch(
  actor: Actor,
  objectType: BusinessObjectType,
  fields: readonly FieldDefinition[],
  changes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const notWritable: string[] = [];

  for (const [key, value] of Object.entries(changes)) {
    const editable = bulkEditableField(objectType, key);
    if (editable !== undefined) {
      if (canWriteField(actor, objectType, key)) properties[editable.property] = value;
      else notWritable.push(key);
      continue;
    }

    const definition = fields.find((field) => field.key === key);
    if (definition?.isSystem === true) {
      // A real field everyone knows exists, so saying so reveals nothing.
      throw new ValidationError([
        {
          path: `changes.${key}`,
          message: 'This field cannot be changed for many records at once',
        },
      ]);
    }
    // Unknown, inactive, hidden and read-only are one answer, as on a single edit.
    if (
      definition === undefined ||
      !definition.isActive ||
      !canWriteField(actor, objectType, key)
    ) {
      notWritable.push(key);
      continue;
    }
    custom[key] = value;
  }

  if (notWritable.length > 0) throw new FieldNotWritableError(notWritable);

  const customResult = buildCustomFieldsPatchSchema(
    fields.filter((field) => field.isActive && !field.isSystem && field.key in custom),
  ).safeParse(custom);
  if (!customResult.success) {
    throw new ValidationError(
      customResult.error.issues.map((issue) => ({
        path: `changes.${issue.path.join('.')}`,
        message: issue.message,
      })),
    );
  }

  const candidate: Record<string, unknown> = {
    ...properties,
    ...(Object.keys(customResult.data).length === 0 ? {} : { customFields: customResult.data }),
  };

  const parsed = UPDATE_SCHEMAS[objectType].safeParse(candidate);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue): ErrorDetail => {
        const [first] = issue.path;
        const key =
          BULK_EDITABLE_FIELDS[objectType].find((field) => field.property === first)?.key ??
          String(first ?? 'changes');
        return { path: `changes.${key}`, message: issue.message };
      }),
    );
  }
  return parsed.data as Record<string, unknown>;
}
