import { Inject, Injectable } from '@nestjs/common';
import { assertCan, canReadField, type Actor } from '@crm/core';
import { DatabaseService } from '../../database/database.service.js';
import { FieldMetadataService } from '../../platform/field-metadata.service.js';
import { ActivitiesRepository } from './activities.repository.js';
import { serializeActivities, type SerializedActivity } from './activities.serializer.js';
import { RecordLinksService, keyFor } from './record-links.service.js';

/**
 * What the card returns. The items are `SerializedActivity`, not the contract's
 * `Activity`: what a caller receives depends on their field permissions, so the
 * contract describes the maximum and the serializer decides the rest.
 */
export interface OverdueSummary {
  readonly count: number | null;
  readonly items: SerializedActivity[];
}

/** How many of the oldest overdue tasks the card lists. The count covers all of them. */
const OVERDUE_SHOWN = 5;

/**
 * Task figures for the dashboard (MVP_SPEC M10, ADR-0038).
 *
 * Overdue is derived from `type`, `due_at` and `status`, so a reader who may not see
 * any of them gets no count: "3 overdue" would tell them the due dates of tasks they
 * cannot see. Scope applies as it does on the activities list — `assigned_to` is
 * the ownership column here (ADR-0026) — and each task's links are filtered to
 * records the reader may open (ADR-0005), exactly as My Day does.
 */
@Injectable()
export class ActivitiesReportsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ActivitiesRepository) private readonly repository: ActivitiesRepository,
    @Inject(FieldMetadataService) private readonly fieldMetadata: FieldMetadataService,
    @Inject(RecordLinksService) private readonly recordLinks: RecordLinksService,
  ) {}

  async overdue(actor: Actor): Promise<OverdueSummary> {
    const decision = assertCan(actor, 'read', { objectType: 'activity' });

    return this.database.runInTenant(
      { tenantId: actor.tenantId, userId: actor.userId },
      async (tx) => {
        if (
          !canReadField(actor, 'activity', 'type') ||
          !canReadField(actor, 'activity', 'due_at') ||
          !canReadField(actor, 'activity', 'status')
        ) {
          return { count: null, items: [] };
        }

        const { count, rows } = await this.repository.overdueTasks(
          tx,
          actor.tenantId,
          decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
          OVERDUE_SHOWN,
        );

        const fields = await this.fieldMetadata.forObject(tx, actor.tenantId, 'activity');
        const linkRows = await this.repository.linksFor(
          tx,
          actor.tenantId,
          rows.map((row) => row.id),
        );
        const resolved = await this.recordLinks.resolveMany(
          tx,
          actor,
          linkRows.map((link) => ({
            objectType: link.objectType as 'account' | 'contact' | 'lead' | 'deal',
            recordId: link.recordId,
          })),
        );

        const linksByActivity = new Map<
          string,
          { objectType: 'account' | 'contact' | 'lead' | 'deal'; recordId: string; label: string }[]
        >();
        for (const link of linkRows) {
          const target = resolved.get(keyFor(link.objectType, link.recordId));
          if (target === undefined) continue;
          const list = linksByActivity.get(link.activityId) ?? [];
          list.push(target);
          linksByActivity.set(link.activityId, list);
        }

        return { count, items: serializeActivities(actor, rows, fields, linksByActivity) };
      },
    );
  }
}
