import { can } from '../permissions/can.js';
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
 *   `tenant_id`, `id`, `version`, `created_*`, `updated_*`, `deleted_at`
 *                not fields at all; the writer sets them
 *   lead `status = converted`   conversion is a transaction of its own
 *                (ADR-0022); a CSV cannot half-convert a lead
 *
 * Two **link** columns are importable on conditions (ADR-0067), because a business moving in
 * needs them and a spreadsheet has no ids:
 *   `owner_id`   given as the e-mail address of a member. Only for someone who may reassign
 *                records of that kind (`update` at `team` or `all` scope and the owner field
 *                writable, the rule `OwnershipService` applies), and to a person that rule
 *                would allow (`team` scope: yourself or a teammate). For everybody else the
 *                column is not offered, is refused if submitted, and every record is owned by
 *                the person importing it, which keeps `own` scope meaningful.
 *   `account_id` contacts only; given as an account's name, domain or id. Only an account the
 *                importer may read is found, and one they may not read answers exactly as one
 *                that does not exist.
 */

export const IMPORTABLE_OBJECT_TYPES = ['account', 'contact', 'lead', 'deal'] as const;
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
 * A deal row names its pipeline and stage **by name** (ADR-0070, the owner's decision of 2026-10-28):
 * matched exactly but ignoring case, a stage inside the pipeline the row names, the default
 * pipeline when the row names none, the first open stage when it names no stage. Two stages of
 * different pipelines may share a name; the pipeline settles which is meant. Nothing is guessed.
 */

/** The system field keys a file may write. Everything else is rejected. */
export const IMPORTABLE_SYSTEM_KEYS: Readonly<Record<ImportableObjectType, readonly string[]>> = {
  contact: ['first_name', 'last_name', 'email', 'phone', 'whatsapp', 'title', 'lead_source'],
  account: ['name', 'domain', 'industry', 'phone', 'email', 'website', 'gstin', 'employee_count'],
  lead: ['first_name', 'last_name', 'company', 'email', 'phone', 'source', 'status'],
  deal: ['name', 'amount', 'probability', 'expected_close_date', 'lost_reason'],
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
  // A deal has no natural key. `external_id` is the person's own id for it and makes a re-run exact;
  // `name` means the same name **on the same account** (ADR-0070).
  deal: ['external_id', 'name'],
};

/**
 * The link columns an import may fill, by object. `owner_id` is a real system field; `account_id`
 * has no field definition (there is no field type for a reference, see `seed/fields.ts`), so
 * both are offered here rather than from metadata.
 */
export const IMPORT_LINK_KEYS: Readonly<Record<ImportableObjectType, readonly string[]>> = {
  contact: ['owner_id', 'account_id'],
  account: ['owner_id'],
  lead: ['owner_id'],
  deal: ['owner_id', 'account_id', 'primary_contact_id', 'pipeline_id', 'stage_id'],
};

/**
 * Plain text columns that are not fields: a deal's own id for itself, kept so that importing the
 * same file again updates the deals instead of doubling them (ADR-0070).
 */
export const IMPORT_PLAIN_KEYS: Readonly<Record<ImportableObjectType, readonly string[]>> = {
  contact: [],
  account: [],
  lead: [],
  deal: ['external_id'],
};

const LINK_LABELS: Readonly<Record<string, string>> = {
  owner_id: 'Owner (e-mail address of a team member)',
  account_id: 'Account (name, domain or ID)',
  primary_contact_id: 'Primary contact (e-mail address)',
  pipeline_id: 'Pipeline (name; blank means the default pipeline)',
  stage_id: 'Stage (name; blank means the first open stage)',
};

const PLAIN_LABELS: Readonly<Record<string, string>> = {
  external_id: 'Your own ID for the deal (lets you import the same file again safely)',
};

/**
 * Whether this actor may fill a link column from a file.
 *
 * Owner: the rule a reassignment is held to (ownership service `actorRefusal`), because a file
 * that names owners is a bulk reassignment. Account: write access to the reference and the right
 * to read accounts, since the account must be one they could pick in a form.
 */
export function canImportLink(
  actor: Actor,
  objectType: ImportableObjectType,
  key: string,
): boolean {
  if (!IMPORT_LINK_KEYS[objectType].includes(key)) return false;
  if (!canWriteField(actor, objectType, key)) return false;

  switch (key) {
    case 'owner_id': {
      const update = can(actor, 'update', { objectType });
      return update.allowed && update.scope !== 'own';
    }
    case 'account_id':
      return can(actor, 'read', { objectType: 'account' }).allowed;
    case 'primary_contact_id':
      return can(actor, 'read', { objectType: 'contact' }).allowed;
    default:
      // Pipeline and stage: where a new deal goes is part of creating it.
      return true;
  }
}

/** Whether this actor may fill a plain text column (a deal's own id). */
export function canImportPlain(
  actor: Actor,
  objectType: ImportableObjectType,
  key: string,
): boolean {
  return IMPORT_PLAIN_KEYS[objectType].includes(key) && canWriteField(actor, objectType, key);
}

/**
 * The date columns an import may fill (ADR-0069). `created_at` is the date a record was really
 * created; it is a bookkeeping column, so it has no field definition and is offered here.
 */
export const IMPORT_DATE_KEYS: Readonly<Record<ImportableObjectType, readonly string[]>> = {
  contact: ['created_at'],
  account: ['created_at'],
  lead: ['created_at'],
  // `closed_at` is the date a won or lost deal closed; only a closed stage may have one.
  deal: ['created_at', 'closed_at'],
};

const DATE_LABELS: Readonly<Record<string, string>> = {
  created_at: 'Created date (original date, YYYY-MM-DD)',
  closed_at: 'Closed date (original date, YYYY-MM-DD; won or lost deals only)',
};

/**
 * Whether this actor may bring original dates in from a file.
 *
 * Its own grant (`import_history:create`, Owner and Admin by default) on top of the field rule: a
 * file that names creation dates lets records claim a past that every report then believes, which
 * is not something `import` alone should allow.
 */
export function canImportDate(
  actor: Actor,
  objectType: ImportableObjectType,
  key: string,
): boolean {
  if (!IMPORT_DATE_KEYS[objectType].includes(key)) return false;
  if (!canWriteField(actor, objectType, key)) return false;
  return can(actor, 'create', { objectType: 'import_history' }).allowed;
}

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

  const targets: ImportTarget[] = fields
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

  const links = IMPORT_LINK_KEYS[objectType]
    .filter((key) => canImportLink(actor, objectType, key))
    .map((key): ImportTarget => ({
      key,
      label: LINK_LABELS[key] ?? key,
      type: 'text',
      required: false,
      isSystem: true,
    }));
  const dates = IMPORT_DATE_KEYS[objectType]
    .filter((key) => canImportDate(actor, objectType, key))
    .map((key): ImportTarget => ({
      key,
      label: DATE_LABELS[key] ?? key,
      type: 'datetime',
      required: false,
      isSystem: true,
    }));
  const plain = IMPORT_PLAIN_KEYS[objectType]
    .filter((key) => canImportPlain(actor, objectType, key))
    .map((key): ImportTarget => ({
      key,
      label: PLAIN_LABELS[key] ?? key,
      type: 'text',
      required: false,
      isSystem: true,
    }));
  return [...targets, ...links, ...plain, ...dates];
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
