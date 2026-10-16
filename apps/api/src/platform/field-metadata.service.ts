import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { FieldDefinition, ObjectType } from '@crm/core';
import { fieldDefinitions, type Tx } from '@crm/db';

/**
 * Reads field metadata (ADR-0004).
 *
 * This is the single source every caller consults instead of hardcoding a field
 * list: validation, list columns, sort and filter whitelists, import and
 * export. The moment a second list exists, one of them drifts — and it is
 * usually export, which is how a field hidden in the UI leaves the building.
 */
@Injectable()
export class FieldMetadataService {
  async forObject(tx: Tx, tenantId: string, objectType: ObjectType): Promise<FieldDefinition[]> {
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
}
