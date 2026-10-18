import { canReadField, canWriteField } from '../permissions/field-access.js';
import type { Actor } from '../permissions/types.js';
import type { FieldDefinition, FieldType } from '../fields/types.js';

/**
 * What an import may write and what an export may read (MVP_SPEC §M8,
 * ADR-0004, ADR-0029).
 *
 * Both sides are driven by `field_definitions`, so a custom field is
 * importable and exportable the moment it exists and nothing here lists a
 * tenant's fields. What *is* listed, deliberately, is the small set of
 * **system** keys an import is allowed to touch. It is an allowlist because
 * the alternative — "every field except these" — fails open: the next column
 * somebody adds to a record becomes importable by default, including the next
 * one that must never be set from a file.
 *
 * Never importable, whatever the metadata says or the actor may write:
 *   `owner_id`   a file must not reassign records; every imported record is
 *                owned by the person importing it, which keeps `own` scope
 *                meaningful (a rep cannot import records into a colleague's
 *                book, or out of their own sight)
 *   `tenant_id`, `id`, `version`, `created_*`, `updated_*`, `deleted_at`
 *                not fields at all; the writer sets them
 *   lead `status = converted`   conversion is a transaction of its own
 *                (ADR-0022); a CSV cannot half-convert a lead
 */

export const IMPORTABLE_OBJECT_TYPES = ['account', 'contact', 'lead'] as const;
export type ImportableObjectType = (typeof IMPORTABLE_OBJECT_TYPES)[number];

export const EXPORTABLE_OBJECT_TYPES = ['account', 'contact', 'lead', 'deal'] as const;
export type ExportableObjectType = (typeof EXPORTABLE_OBJECT_TYPES)[number];

export function isImportableObjectType(value: unknown): value is ImportableObjectType {
  return (IMPORTABLE_OBJECT_TYPES as readonly unknown[]).includes(value);
}

export function isExportableObjectType(value: unknown): value is ExportableObjectType {
  return (EXPORTABLE_OBJECT_TYPES as readonly unknown[]).includes(value);
}

/**
 * Deal import is deliberately absent. A deal row must name a pipeline and a
 * stage, and MVP_SPEC does not say how a spreadsheet identifies one (by name?
 * by id? what when two pipelines share a stage name?). CLAUDE.md §11.8: ask,
 * do not invent a business rule. Everything below is written so adding `deal`
 * is a descriptor and a rule, not a redesign.
 */

/** The system field keys a file may write. Everything else is rejected. */
export const IMPORTABLE_SYSTEM_KEYS: Readonly<Record<ImportableObjectType, readonly string[]>> = {
  contact: ['first_name', 'last_name', 'email', 'phone', 'whatsapp', 'title', 'lead_source'],
  account: ['name', 'domain', 'industry', 'phone', 'email', 'website', 'gstin', 'employee_count'],
  lead: ['first_name', 'last_name', 'company', 'email', 'phone', 'source', 'status'],
};

/**
 * The fields a row can be matched on to find an existing record, in the order
 * the UI offers them. All are indexed (`*_tenant_email_idx`, `*_tenant_phone_idx`,
 * `accounts_tenant_domain_idx`) so matching 500 rows is one indexed query.
 */
export const MATCH_FIELDS: Readonly<Record<ImportableObjectType, readonly string[]>> = {
  contact: ['email', 'phone'],
  account: ['domain', 'name'],
  lead: ['email', 'phone'],
};

/** A value `status` may not take from a file. See above. */
export const LEAD_STATUS_BLOCKED_FROM_IMPORT = 'converted';

export interface ImportTarget {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly isSystem: boolean;
  /** Valid values, for picklists, so the mapping screen can say what is accepted. */
  readonly options?: readonly string[];
}

/**
 * The fields this actor may map a column to.
 *
 * Active metadata, intersected with the system allowlist, intersected with
 * **field-level write permission**: a column can only ever be mapped to a
 * field the importer could have typed into a form. A field they may read but
 * not write is simply not offered, and is refused if somebody submits it
 * anyway (`validateMapping`), because the screen is cosmetic and the API
 * enforces (CLAUDE.md §9).
 */
export function importTargets(
  actor: Actor,
  objectType: ImportableObjectType,
  fields: readonly FieldDefinition[],
): ImportTarget[] {
  const systemAllowed = new Set(IMPORTABLE_SYSTEM_KEYS[objectType]);

  return fields
    .filter((field) => field.isActive)
    .filter((field) => !field.isSystem || systemAllowed.has(field.key))
    .filter((field) => canWriteField(actor, objectType, field.key))
    .map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      isSystem: field.isSystem,
      ...(field.options === undefined
        ? {}
        : {
            options: field.options
              .filter((option) => option.isActive !== false)
              .map((option) => option.value),
          }),
    }));
}

export interface MappingEntry {
  readonly column: number;
  readonly field: string;
}

export interface MappingIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Check a submitted mapping against what the actor may import.
 *
 * Returns every problem rather than the first, so the screen can show them
 * together. An unknown field and a field the actor may not write get the same
 * message: the error must not be a way to discover that a hidden field exists
 * (CLAUDE.md §5.4).
 */
export function validateMapping(
  actor: Actor,
  objectType: ImportableObjectType,
  fields: readonly FieldDefinition[],
  mapping: readonly MappingEntry[],
  options: {
    readonly columnCount: number;
    readonly duplicateMode: 'skip' | 'update' | 'create';
    readonly matchField: string | null;
  },
): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const targets = importTargets(actor, objectType, fields);
  const targetKeys = new Set(targets.map((target) => target.key));

  const seenColumns = new Set<number>();
  const seenFields = new Set<string>();

  mapping.forEach((entry, index) => {
    const path = `mapping.${index}`;
    if (
      !Number.isInteger(entry.column) ||
      entry.column < 0 ||
      entry.column >= options.columnCount
    ) {
      issues.push({ path, message: 'That column is not in the file' });
    } else if (seenColumns.has(entry.column)) {
      issues.push({ path, message: 'A column can be mapped to only one field' });
    }
    seenColumns.add(entry.column);

    if (!targetKeys.has(entry.field)) {
      issues.push({ path, message: `Cannot import into ${entry.field}` });
    } else if (seenFields.has(entry.field)) {
      issues.push({ path, message: 'A field can be filled from only one column' });
    }
    seenFields.add(entry.field);
  });

  // A required field nobody fills is a file that fails on every row. Say so
  // once, up front, rather than writing 50,000 identical error lines.
  for (const target of targets) {
    if (target.required && !seenFields.has(target.key)) {
      issues.push({ path: 'mapping', message: `${target.label} is required and is not mapped` });
    }
  }
  // The same when the actor cannot write a required field at all.
  for (const field of fields) {
    if (!field.isActive || !field.required) continue;
    if (field.isSystem && !IMPORTABLE_SYSTEM_KEYS[objectType].includes(field.key)) continue;
    if (!canWriteField(actor, objectType, field.key)) {
      issues.push({
        path: 'mapping',
        message: `${field.label} is required and you do not have permission to import it`,
      });
    }
  }

  if (options.duplicateMode !== 'create') {
    if (options.matchField === null || !MATCH_FIELDS[objectType].includes(options.matchField)) {
      issues.push({ path: 'matchField', message: 'Choose a field to detect duplicates by' });
    } else if (!seenFields.has(options.matchField)) {
      issues.push({
        path: 'matchField',
        message: 'The field used to detect duplicates must be mapped to a column',
      });
    }
  }

  return issues;
}

/** Which field keys an export may include: active, and readable by this actor. */
export function exportableFields(
  actor: Actor,
  objectType: ExportableObjectType,
  fields: readonly FieldDefinition[],
): FieldDefinition[] {
  return fields
    .filter((field) => field.isActive)
    .filter((field) => canReadField(actor, objectType, field.key));
}
