import { Injectable } from '@nestjs/common';
import type { OwnedObjectType, OwnedTable, ReassignedRow } from '@crm/db';
import type { Actor } from '@crm/core';
import type { Tx } from '@crm/db';

/**
 * How an object type says "this is where my owner lives" (CLAUDE.md §3).
 *
 * Reassigning ownership is one capability across every owned object, but the
 * tables are each module's own, and no module may reach into another's. So each
 * module **registers** the one fact the platform needs about its table — its
 * name and which column holds the owner — and the access module drives the
 * single shared statement (`reassignOwned` in `@crm/db`) with those names. The
 * names are constants in the registering module's code, never request values.
 */
export interface OwnershipPort {
  readonly objectType: OwnedObjectType;
  readonly table: OwnedTable;
  /**
   * What else must happen when these records change owner, beyond the audit
   * entry and `<object>.updated.v1` event the access module writes for all of
   * them. Runs in the same transaction. Activities use it to tell the new
   * assignee, as an edit would (ADR-0025, ADR-0026).
   */
  readonly afterReassign?: (
    tx: Tx,
    actor: Actor,
    moved: readonly ReassignedRow[],
    toOwnerId: string,
  ) => Promise<void>;
}

@Injectable()
export class OwnershipRegistry {
  private readonly ports = new Map<OwnedObjectType, OwnershipPort>();

  register(port: OwnershipPort): void {
    this.ports.set(port.objectType, port);
  }

  get(objectType: OwnedObjectType): OwnershipPort | undefined {
    return this.ports.get(objectType);
  }
}
