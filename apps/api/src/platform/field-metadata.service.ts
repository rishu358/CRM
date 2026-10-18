import { Injectable } from '@nestjs/common';
import type { FieldDefinition, ObjectType } from '@crm/core';
import { loadFieldDefinitions, type Tx } from '@crm/db';

/**
 * Reads field metadata (ADR-0004).
 *
 * This is the single source every caller consults instead of hardcoding a field
 * list: validation, list columns, sort and filter whitelists, import and
 * export. The moment a second list exists, one of them drifts — and it is
 * usually export, which is how a field hidden in the UI leaves the building.
 *
 * The query itself lives in `@crm/db` (`loadFieldDefinitions`) so the worker,
 * which runs imports and exports, reads exactly the same rows in exactly the
 * same order.
 */
@Injectable()
export class FieldMetadataService {
  async forObject(tx: Tx, tenantId: string, objectType: ObjectType): Promise<FieldDefinition[]> {
    return loadFieldDefinitions(tx, tenantId, objectType);
  }
}
