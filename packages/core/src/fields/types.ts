/**
 * Field metadata (ADR-0004).
 *
 * `field_definitions` rows describe what a tenant's objects actually look like.
 * Nothing in the API or UI may assume a fixed field list; validation, forms,
 * list columns, filters, import and export are all generated from these.
 */

/** The field types shipping in P0 (MVP_SPEC §6.3). */
export const FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'boolean',
  'picklist',
  'multi_picklist',
  'email',
  'phone',
  'url',
  'user_lookup',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_TYPE_SET: ReadonlySet<string> = new Set(FIELD_TYPES);

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && FIELD_TYPE_SET.has(value);
}

/** One selectable value of a picklist. */
export interface PicklistOption {
  readonly value: string;
  readonly label: string;
  /** Inactive options stay valid on existing records but are not offered. */
  readonly isActive?: boolean;
}

/** Per-type constraints, all optional and all enforced in `buildFieldSchema`. */
export interface FieldValidation {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** For number, currency and percent. Expressed as a decimal string to stay exact. */
  readonly min?: string;
  readonly max?: string;
  /** Anchored, non-backtracking regex source. Applied to text-like types only. */
  readonly pattern?: string;
  /** For currency fields: restrict to these ISO-4217 codes. */
  readonly allowedCurrencies?: readonly string[];
}

export interface FieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  /** Picklist and multi_picklist only. */
  readonly options?: readonly PicklistOption[];
  readonly validation?: FieldValidation;
  /**
   * System fields are defined by us, not by the tenant. They may be reordered or
   * relabelled but never deleted, and their `key` and `type` are fixed.
   */
  readonly isSystem: boolean;
  /**
   * Deactivating hides a field and stops it being written, but keeps its data
   * (MVP_SPEC M9: no destructive deletes).
   */
  readonly isActive: boolean;
  readonly position: number;
}

/** Field keys must be safe to use as an object key and a JSON path segment. */
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export function isValidFieldKey(value: unknown): value is string {
  return typeof value === 'string' && FIELD_KEY_PATTERN.test(value);
}
