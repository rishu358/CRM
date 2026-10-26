import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, type Actor } from '@crm/core';
import { DatabaseService } from '../database/database.service.js';
import { loadActor } from '@crm/db';

/**
 * Builds the Actor that `can()` reasons about (ADR-0008).
 *
 * Every value is read from the database inside a tenant-scoped transaction.
 * Nothing comes from the request body, a query parameter or a header
 * (CLAUDE.md §5.2) — an Actor assembled from client input would defeat the
 * entire permission engine, so this is the only place Actors are made.
 *
 * Membership is what proves the user belongs to the tenant at all. A user who
 * has a valid session but no active membership is refused here, which is why a
 * stale session cannot outlive someone being removed from a company.
 */
@Injectable()
export class ActorService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async resolve(userId: string, tenantId: string): Promise<Actor> {
    return this.database.runInTenant({ tenantId, userId }, async (tx) => {
      // The query itself lives in @crm/db so the worker judges a background job
      // by exactly the same definition of "may" the API uses for a request.
      const actor = await loadActor(tx, userId, tenantId);
      if (actor === null) {
        // Indistinguishable from "tenant does not exist", because RLS returned
        // nothing either way. Nothing here reveals whether the tenant is real.
        throw new ForbiddenError('You do not have access to this workspace');
      }
      return actor;
    });
  }
}
