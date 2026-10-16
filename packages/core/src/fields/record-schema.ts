import { z } from 'zod';
import { buildFieldSchema } from './schema.js';
import type { FieldDefinition } from './types.js';

/**
 * Build the validator for a whole object's custom fields.
 *
 * Strict by CLAUDE.md §5.6: an unknown key is an error, not something to drop
 * quietly. Silently discarding keys lets a client believe a value was saved, and
 * hides both typos and probing.
 *
 * Inactive fields are excluded, so a deactivated field stops accepting writes
 * while its stored data stays untouched (MVP_SPEC M9).
 */
export function buildCustomFieldsSchema(
  definitions: readonly FieldDefinition[],
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const definition of definitions) {
    if (!definition.isActive) continue;
    shape[definition.key] = buildFieldSchema(definition);
  }
  return z.strictObject(shape);
}

/**
 * The same, but for a PATCH: every field becomes optional so a caller may send
 * only what changed. Required fields are still rejected if sent as null.
 */
export function buildCustomFieldsPatchSchema(
  definitions: readonly FieldDefinition[],
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const definition of definitions) {
    if (!definition.isActive) continue;
    shape[definition.key] = buildFieldSchema(definition).optional();
  }
  return z.strictObject(shape);
}

/** The keys a caller actually supplied, for the field-permission check. */
export function suppliedFieldKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload);
}

/** Active definitions in display order. */
export function activeFields(definitions: readonly FieldDefinition[]): FieldDefinition[] {
  return definitions
    .filter((definition) => definition.isActive)
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/**
 * Fields that may be sorted or filtered on.
 *
 * This is the whitelist CLAUDE.md §5.7 requires: a client-supplied sort or
 * filter key is checked against it before it goes anywhere near SQL. Types with
 * no useful total order are excluded rather than left to sort arbitrarily.
 */
const UNSORTABLE_TYPES = new Set(['long_text', 'multi_picklist']);

export function sortableFieldKeys(definitions: readonly FieldDefinition[]): string[] {
  return activeFields(definitions)
    .filter((definition) => !UNSORTABLE_TYPES.has(definition.type))
    .map((definition) => definition.key);
}

export function filterableFieldKeys(definitions: readonly FieldDefinition[]): string[] {
  return activeFields(definitions).map((definition) => definition.key);
}
