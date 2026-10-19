import type { FieldDefinition, ObjectType } from '@crm/core';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { fieldDefinitions } from '../schema/metadata.js';

/**
 * A tenant's field metadata for one object (ADR-0004).
 *
 * The single reader. The API's `FieldMetadataService` delegates here, and the
 * worker calls it directly, so an import or export is driven by the very same
 * rows — in the same order — a form or a list is. Two readers is how an import
 * ends up offering a field the form no longer has.
 */
export async function loadFieldDefinitions(
  tx: Tx,
  tenantId: string,
  objectType: ObjectType,
): Promise<FieldDefinition[]> {
  const rows = await tx
    .select()
    .from(fieldDefinitions)
    .where(
      and(eq(fieldDefinitions.tenantId, tenantId), eq(fieldDefinitions.objectType, objectType)),
    );

  return rows
    .map((row): FieldDefinition => ({
      key: row.key,
      label: row.label,
      type: row.type as FieldDefinition['type'],
      required: row.required,
      ...(row.options ? { options: row.options } : {}),
      ...(row.validation ? { validation: row.validation } : {}),
      isSystem: row.isSystem,
      isActive: row.isActive,
      position: row.position,
    }))
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}
