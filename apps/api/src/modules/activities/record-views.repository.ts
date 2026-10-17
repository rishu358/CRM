import { Injectable } from '@nestjs/common';
import type { LinkTargetType } from '@crm/core';
import { recordViews, type RecordView, type Tx, and, desc, eq, sql } from '@crm/db';

/**
 * "Recently viewed", as rows (MVP_SPEC M6).
 *
 * One row per person per record, moved forward on each view. The alternative
 * — appending a log — grows without bound and has to be de-duplicated on
 * every read, which is a sort over a big table to render a list of ten.
 */
@Injectable()
export class RecordViewsRepository {
  /** Record a view, or move an existing one forward. */
  async touch(
    tx: Tx,
    values: {
      id: string;
      tenantId: string;
      userId: string;
      objectType: LinkTargetType;
      recordId: string;
    },
  ): Promise<void> {
    await tx
      .insert(recordViews)
      .values({
        ...values,
        viewedAt: new Date(),
        createdBy: values.userId,
        updatedBy: values.userId,
      })
      .onConflictDoUpdate({
        target: [
          recordViews.tenantId,
          recordViews.userId,
          recordViews.objectType,
          recordViews.recordId,
        ],
        set: { viewedAt: new Date(), updatedAt: new Date(), updatedBy: values.userId },
      });
  }

  /** This person's most recent views, newest first. */
  async recent(tx: Tx, tenantId: string, userId: string, limit: number): Promise<RecordView[]> {
    return tx
      .select()
      .from(recordViews)
      .where(and(eq(recordViews.tenantId, tenantId), eq(recordViews.userId, userId)))
      .orderBy(desc(recordViews.viewedAt), desc(recordViews.id))
      .limit(limit);
  }

  /**
   * Keep only this person's most recent `keep` rows.
   *
   * Called after a view is recorded. Without it the table grows one row per
   * record a person ever opens, forever, to serve a list of ten.
   */
  async trim(tx: Tx, tenantId: string, userId: string, keep: number): Promise<void> {
    await tx.execute(sql`
      delete from record_views rv
      where rv.tenant_id = ${tenantId}
        and rv.user_id = ${userId}
        and rv.id not in (
          select inner_views.id from record_views inner_views
          where inner_views.tenant_id = ${tenantId}
            and inner_views.user_id = ${userId}
          order by inner_views.viewed_at desc, inner_views.id desc
          limit ${keep}
        )
    `);
  }
}
