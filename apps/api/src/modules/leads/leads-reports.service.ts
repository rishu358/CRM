import { Inject, Injectable } from '@nestjs/common';
import { assertCan, canReadField, type Actor } from '@crm/core';
import type { DashboardLeadsBySource } from '@crm/contracts';
import { DatabaseService } from '../../database/database.service.js';
import { LeadsRepository } from './leads.repository.js';

/** Sources shown by name. The rest are folded into one "other" so the rows add up. */
const SOURCES_SHOWN = 8;

/**
 * Lead figures for the dashboard (MVP_SPEC M10, ADR-0038).
 *
 * "Open" means every current lead that is not converted and not deleted
 * (ADR-0038 decision 4). The actor's record scope is in the SQL, so the numbers
 * are the ones the leads list would add up to for that person.
 *
 * Without `source` the breakdown is `null` — grouping by a hidden column would
 * disclose it — but the total is still given: how many leads there are is not
 * the source of any of them. Without `status` there is neither, because "not
 * converted" is what the total is made of.
 */
@Injectable()
export class LeadsReportsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LeadsRepository) private readonly repository: LeadsRepository,
  ) {}

  async bySource(actor: Actor): Promise<DashboardLeadsBySource> {
    const decision = assertCan(actor, 'read', { objectType: 'lead' });

    return this.database.runInTenant(
      { tenantId: actor.tenantId, userId: actor.userId },
      async (tx) => {
        const groups = await this.repository.countsBySource(
          tx,
          actor.tenantId,
          decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
        );
        const total = groups.reduce((sum, group) => sum + group.count, 0);

        // "Not converted" is a statement about `status`: with it hidden, even the
        // total would tell the reader how many leads are converted.
        if (!canReadField(actor, 'lead', 'status')) {
          return { total: null, sources: null, otherCount: 0 };
        }
        if (!canReadField(actor, 'lead', 'source')) {
          return { total, sources: null, otherCount: 0 };
        }

        const shown = groups.slice(0, SOURCES_SHOWN);
        return {
          total,
          sources: shown,
          otherCount: groups.slice(SOURCES_SHOWN).reduce((sum, group) => sum + group.count, 0),
        };
      },
    );
  }
}
