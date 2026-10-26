import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@crm/core';
import type {
  DashboardLeaderboard,
  DashboardLeadsBySource,
  DashboardPipeline,
  DashboardPipelineQuery,
  DashboardWon,
} from '@crm/contracts';
import { DatabaseService } from '../../database/database.service.js';
import {
  ActivitiesReportsService,
  type OverdueSummary,
} from '../activities/activities-reports.service.js';
import { MemberDirectory } from '../access/member-directory.service.js';
import { DealsReportsService } from '../deals/deals-reports.service.js';
import { LeadsReportsService } from '../leads/leads-reports.service.js';

/** What a leaderboard row says when the person has since left the company. */
const FORMER_MEMBER = 'Former member';

/**
 * The home dashboard (MVP_SPEC M10, ADR-0038).
 *
 * This module owns no table and no query. Every figure comes from the module
 * that owns the records, through that module's public service, and each of those
 * authorizes with `can()` against its own object and applies the reader's scope
 * and field permissions in SQL and in what it returns. So the dashboard cannot
 * show anybody a number the list of the same records would not have added up to:
 * there is no second place where the rules are written.
 *
 * What it adds is composition — today only the names on the leaderboard.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DealsReportsService) private readonly deals: DealsReportsService,
    @Inject(LeadsReportsService) private readonly leads: LeadsReportsService,
    @Inject(ActivitiesReportsService) private readonly activities: ActivitiesReportsService,
    @Inject(MemberDirectory) private readonly members: MemberDirectory,
  ) {}

  pipeline(actor: Actor, query: DashboardPipelineQuery): Promise<DashboardPipeline> {
    return this.deals.pipeline(actor, query);
  }

  won(actor: Actor): Promise<DashboardWon> {
    return this.deals.won(actor);
  }

  leadsBySource(actor: Actor): Promise<DashboardLeadsBySource> {
    return this.leads.bySource(actor);
  }

  overdueTasks(actor: Actor): Promise<OverdueSummary> {
    return this.activities.overdue(actor);
  }

  /**
   * The deals module ranks owners it was allowed to see; this puts a name on each.
   *
   * Only the people already in the ranking are looked up, and only their display
   * names come back, so the leaderboard is not a way to browse the company's
   * members. A person who is no longer an active member is still ranked — their
   * wins happened — under a neutral label rather than a stale or erased name.
   */
  async leaderboard(actor: Actor): Promise<DashboardLeaderboard> {
    const board = await this.deals.leaderboard(actor);
    if (board.rows === null) return { ...board, rows: null };

    const names = await this.database.runInTenant(
      { tenantId: actor.tenantId, userId: actor.userId },
      (tx) =>
        this.members.displayNames(tx, actor.tenantId, board.rows?.map((row) => row.userId) ?? []),
    );

    return {
      ...board,
      rows: board.rows.map((row) => ({
        ...row,
        name: names.get(row.userId) ?? FORMER_MEMBER,
        isYou: row.userId === actor.userId,
      })),
    };
  }
}
