import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  canReadField,
  ForbiddenError,
  NotFoundError,
  zero,
  type Actor,
} from '@crm/core';
import type { DashboardPipeline, DashboardPipelineQuery, DashboardWon } from '@crm/contracts';
import type { Tx } from '@crm/db';
import { DatabaseService } from '../../database/database.service.js';
import {
  CurrencyConverter,
  type CurrencyBucket,
} from '../../platform/exchange-rates/currency-converter.service.js';
import { TenantClock } from '../../platform/tenant-clock.service.js';
import { PipelinesService } from '../pipelines/pipelines.service.js';
import {
  DealsRepository,
  type BoardCell,
  type MonthWindow,
  type WonCell,
} from './deals.repository.js';

/** How many people the leaderboard shows. A league table, not a roster. */
const LEADERBOARD_SIZE = 10;

/** A group of deals, totalled in the company currency. */
interface Totalled {
  readonly count: number;
  readonly total: { amountMinor: string; currency: string } | null;
  readonly unconverted: { currency: string; count: number; amountMinor: string }[];
}

/** What `leaderboard` hands the dashboard module, before it adds names. */
export interface Leaderboard {
  readonly currency: string;
  readonly timeZone: string;
  readonly month: { start: string; end: string };
  readonly rankedBy: 'amount' | 'count';
  readonly rows:
    | {
        userId: string;
        count: number;
        total: { amountMinor: string; currency: string } | null;
        partial: boolean;
      }[]
    | null;
}

/**
 * Deal figures for the dashboard (MVP_SPEC M10, ADR-0038).
 *
 * Lives beside `DealsService` rather than in it because it is read-only
 * aggregation with its own rules, and shares only what a deals read always has:
 * the actor's scope goes into SQL, and a field the actor may not read does not
 * come back as a number. It is the deals module's own code — it uses the
 * repository directly, which the dashboard module may not.
 *
 * ## What a hidden field takes away
 *
 * A total is the amounts, so without `amount` there is a count and no total. A
 * "won this month" figure is a statement about `closed_at`, so without it there
 * is nothing at all. The leaderboard additionally needs `owner_id`, because
 * grouping by a hidden column discloses it. Each is `null`, never zero.
 */
@Injectable()
export class DealsReportsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DealsRepository) private readonly repository: DealsRepository,
    @Inject(PipelinesService) private readonly pipelines: PipelinesService,
    @Inject(CurrencyConverter) private readonly converter: CurrencyConverter,
    @Inject(TenantClock) private readonly clock: TenantClock,
  ) {}

  /** Open pipeline value by stage: the board's totals, minus the closed columns. */
  async pipeline(actor: Actor, query: DashboardPipelineQuery): Promise<DashboardPipeline> {
    const decision = assertCan(actor, 'read', { objectType: 'deal' });
    // A stage count is a statement about `stage_id`; the list refuses to filter on
    // a field the reader cannot see, so this refuses to group by it.
    if (!canReadField(actor, 'deal', 'stage_id')) throw new ForbiddenError();

    return this.inTenant(actor, async (tx) => {
      const pipelineId =
        query.pipelineId ?? (await this.pipelines.defaultPipelineId(tx, actor.tenantId));
      const stages = await this.pipelines.stagesOf(tx, actor.tenantId, pipelineId);
      if (stages === null) throw new NotFoundError('Pipeline');

      const currency = await this.converter.defaultCurrency(tx, actor.tenantId);
      const cells = await this.repository.boardCells(
        tx,
        actor.tenantId,
        pipelineId,
        decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
      );
      const showAmounts = canReadField(actor, 'deal', 'amount');

      const open = stages.filter((stage) => stage.stageType === 'open');
      const columns = [];
      for (const stage of open) {
        const mine = cells.filter((cell) => cell.stageId === stage.id);
        const totalled = await this.total(tx, actor, currency, mine, showAmounts);
        columns.push({ stageId: stage.id, name: stage.name, ...totalled });
      }

      const openIds = new Set(open.map((stage) => stage.id));
      const everything = await this.total(
        tx,
        actor,
        currency,
        merge(cells.filter((cell) => openIds.has(cell.stageId))),
        showAmounts,
      );

      return {
        pipelineId,
        currency,
        stages: columns.map(({ stageId, name, count, total, unconverted }) => ({
          stageId,
          name,
          count,
          total,
          unconverted,
        })),
        open: everything,
      };
    });
  }

  /** Deals won this month, against last. */
  async won(actor: Actor): Promise<DashboardWon> {
    const decision = assertCan(actor, 'read', { objectType: 'deal' });

    return this.inTenant(actor, async (tx) => {
      const currency = await this.converter.defaultCurrency(tx, actor.tenantId);
      const timeZone = await this.clock.timeZone(tx, actor.tenantId);
      const window = await this.repository.monthWindow(tx, timeZone);
      const month = { start: window.start.toISOString(), end: window.end.toISOString() };

      // "Won this month" is a statement about `closed_at`.
      if (!canReadField(actor, 'deal', 'closed_at')) {
        return { currency, timeZone, month, current: null, previous: null };
      }

      const cells = await this.wonCells(tx, actor, decision, window);
      const showAmounts = canReadField(actor, 'deal', 'amount');

      return {
        currency,
        timeZone,
        month,
        current: await this.total(
          tx,
          actor,
          currency,
          merge(cells.filter((cell) => cell.period === 'current')),
          showAmounts,
        ),
        previous: await this.total(
          tx,
          actor,
          currency,
          merge(cells.filter((cell) => cell.period === 'previous')),
          showAmounts,
        ),
      };
    });
  }

  /**
   * Deals won this month by owner, over the deals the actor's scope admits.
   *
   * Ranked by converted value; a person with an unconvertible currency is ranked
   * on what could be converted and marked `partial`, never dropped and never
   * shown as if complete. Without `amount` it ranks by count and shows no money.
   */
  async leaderboard(actor: Actor): Promise<Leaderboard> {
    const decision = assertCan(actor, 'read', { objectType: 'deal' });

    return this.inTenant(actor, async (tx) => {
      const currency = await this.converter.defaultCurrency(tx, actor.tenantId);
      const timeZone = await this.clock.timeZone(tx, actor.tenantId);
      const window = await this.repository.monthWindow(tx, timeZone);
      const month = { start: window.start.toISOString(), end: window.end.toISOString() };
      const showAmounts = canReadField(actor, 'deal', 'amount');
      const rankedBy = showAmounts ? 'amount' : 'count';

      // Grouping by owner discloses `owner_id`, so it needs the same right.
      if (!canReadField(actor, 'deal', 'closed_at') || !canReadField(actor, 'deal', 'owner_id')) {
        return { currency, timeZone, month, rankedBy, rows: null };
      }

      const cells = (await this.wonCells(tx, actor, decision, window)).filter(
        (cell) => cell.period === 'current' && cell.ownerId !== null,
      );
      const owners = [...new Set(cells.map((cell) => cell.ownerId as string))];

      const ranked = [];
      for (const userId of owners) {
        const mine = merge(cells.filter((cell) => cell.ownerId === userId));
        const totalled = await this.total(tx, actor, currency, mine, showAmounts);
        ranked.push({
          userId,
          count: totalled.count,
          total: totalled.total,
          partial: totalled.unconverted.length > 0,
          value: totalled.total === null ? 0n : BigInt(totalled.total.amountMinor),
        });
      }

      ranked.sort((a, b) => {
        if (showAmounts && a.value !== b.value) return a.value > b.value ? -1 : 1;
        if (a.count !== b.count) return b.count - a.count;
        return a.userId < b.userId ? -1 : 1;
      });

      return {
        currency,
        timeZone,
        month,
        rankedBy,
        rows: ranked
          .slice(0, LEADERBOARD_SIZE)
          .map(({ userId, count, total, partial }) => ({ userId, count, total, partial })),
      };
    });
  }

  private async wonCells(
    tx: Tx,
    actor: Actor,
    decision: ReturnType<typeof assertCan>,
    window: MonthWindow,
  ): Promise<WonCell[]> {
    const wonStageIds = await this.pipelines.stageIdsOfKind(tx, actor.tenantId, 'won');
    return this.repository.wonCells(
      tx,
      actor.tenantId,
      decision.allowed ? decision.constraint : { kind: 'own', userId: actor.userId },
      wonStageIds,
      window,
    );
  }

  /**
   * Count, and the converted value if the actor may see amounts.
   *
   * Converts per-currency subtotals once, as the converter's contract asks, so
   * the number does not depend on how the deals were grouped on the way in.
   */
  private async total(
    tx: Tx,
    actor: Actor,
    currency: string,
    cells: readonly Pick<BoardCell, 'currency' | 'count' | 'withAmount' | 'amountMinor'>[],
    showAmounts: boolean,
  ): Promise<Totalled> {
    const count = cells.reduce((sum, cell) => sum + cell.count, 0);
    if (!showAmounts) return { count, total: null, unconverted: [] };

    const buckets: CurrencyBucket[] = cells.flatMap((cell) =>
      cell.currency === null || cell.withAmount === 0
        ? []
        : [{ currency: cell.currency, amountMinor: cell.amountMinor, count: cell.withAmount }],
    );
    const converted = await this.converter.totalIn(tx, actor.tenantId, currency, buckets);
    const total = converted.total ?? zero(currency);

    return {
      count,
      total: { amountMinor: total.amountMinor.toString(), currency: total.currency },
      unconverted: converted.unconverted.map((bucket) => ({
        currency: bucket.currency,
        count: bucket.count,
        amountMinor: bucket.amountMinor.toString(),
      })),
    };
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

/** Fold cells of the same currency together, so each currency converts once. */
function merge(cells: readonly (WonCell | BoardCell)[]): BoardCell[] {
  const byCurrency = new Map<string | null, BoardCell>();
  for (const cell of cells) {
    const key = cell.currency;
    const existing = byCurrency.get(key);
    byCurrency.set(key, {
      stageId: '',
      currency: key,
      count: (existing?.count ?? 0) + cell.count,
      withAmount: (existing?.withAmount ?? 0) + cell.withAmount,
      amountMinor: (existing?.amountMinor ?? 0n) + cell.amountMinor,
    });
  }
  return [...byCurrency.values()];
}
