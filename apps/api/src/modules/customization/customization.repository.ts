import { Injectable } from '@nestjs/common';
import type { FieldValidation, PicklistOption } from '@crm/core';
import {
  fieldDefinitions,
  type FieldDefinitionRow,
  type NewFieldDefinitionRow,
  type Tx,
  and,
  asc,
  eq,
  sql,
} from '@crm/db';

/**
 * Data access for field definitions.
 *
 * Only the customization service calls this. Everything else that needs a
 * definition reads it through `FieldMetadataService`, which is read-only by
 * construction.
 *
 * The application role cannot delete a row and can update only the columns an
 * administrator edits (migration 0019), so even a mistake in this file cannot
 * rename a key, retype a field or remove one: the database refuses.
 */

/** The columns an edit may change. Anything else is not in this type, so cannot be passed. */
export interface DefinitionPatch {
  readonly label?: string;
  readonly required?: boolean;
  readonly options?: readonly PicklistOption[];
  readonly validation?: FieldValidation | null;
  readonly helpText?: string | null;
  readonly section?: string | null;
  readonly isActive?: boolean;
}

@Injectable()
export class CustomizationRepository {
  async list(
    tx: Tx,
    tenantId: string,
    objectType: string,
    includeInactive: boolean,
  ): Promise<FieldDefinitionRow[]> {
    const predicates = [
      eq(fieldDefinitions.tenantId, tenantId),
      eq(fieldDefinitions.objectType, objectType),
    ];
    if (!includeInactive) predicates.push(eq(fieldDefinitions.isActive, true));

    return tx
      .select()
      .from(fieldDefinitions)
      .where(and(...predicates))
      .orderBy(asc(fieldDefinitions.position), asc(fieldDefinitions.key));
  }

  async findById(tx: Tx, tenantId: string, id: string): Promise<FieldDefinitionRow | null> {
    const rows = await tx
      .select()
      .from(fieldDefinitions)
      .where(and(eq(fieldDefinitions.tenantId, tenantId), eq(fieldDefinitions.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(tx: Tx, values: NewFieldDefinitionRow): Promise<FieldDefinitionRow> {
    const rows = await tx.insert(fieldDefinitions).values(values).returning();
    const row = rows[0];
    if (row === undefined) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Apply an edit if nobody saved since the editor read the row.
   *
   * Null means the version moved (the row is known to exist, the caller just loaded
   * it), so the answer is a 409, never a silent overwrite.
   */
  async update(
    tx: Tx,
    tenantId: string,
    id: string,
    version: number,
    patch: DefinitionPatch,
    actorId: string,
  ): Promise<FieldDefinitionRow | null> {
    const rows = await tx
      .update(fieldDefinitions)
      .set({
        ...patch,
        version: sql`${fieldDefinitions.version} + 1`,
        updatedAt: sql`now()`,
        updatedBy: actorId,
      })
      .where(
        and(
          eq(fieldDefinitions.tenantId, tenantId),
          eq(fieldDefinitions.id, id),
          eq(fieldDefinitions.version, version),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Move one row to a position, bumping its version like any other edit. */
  async setPosition(
    tx: Tx,
    tenantId: string,
    id: string,
    position: number,
    actorId: string,
  ): Promise<void> {
    await tx
      .update(fieldDefinitions)
      .set({
        position,
        version: sql`${fieldDefinitions.version} + 1`,
        updatedAt: sql`now()`,
        updatedBy: actorId,
      })
      .where(and(eq(fieldDefinitions.tenantId, tenantId), eq(fieldDefinitions.id, id)));
  }
}
