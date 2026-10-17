'use client';

import { Button, ErrorState, Select, Skeleton, cn } from '@crm/ui';
import Link from 'next/link';
import { useRef, useState, type DragEvent } from 'react';
import {
  flattenDealPages,
  useDealBoard,
  useMoveDeal,
  useStageDeals,
  type BoardColumn,
  type DealRecord,
  type PipelineRecord,
  type StageRecord,
} from '../lib/deals';
import { DEFAULT_PREFERENCES, formatDate, formatMoney } from '../lib/format';
import { t } from '../lib/i18n';
import { LostReasonDialog } from './lost-reason-dialog';

/**
 * The Kanban board (MVP_SPEC M5).
 *
 * One column per stage, each paging its own cards. A card moves by dragging it
 * to another column or — for anyone who cannot drag — by choosing the stage in
 * the menu on the card: both go through the same `moveDeal`, so there is one
 * code path and one set of rules (CLAUDE.md §9: keyboard reachable).
 *
 * The drag uses the browser's own drag-and-drop rather than a library. It needs
 * no dependency (CLAUDE.md §11.4), and every interaction it does not cover —
 * keyboard, touch — is covered by the menu, which a drag library would also
 * have needed.
 *
 * Nothing here decides what a move *means*. Moving to a won stage closes the
 * deal; moving to a lost one needs a reason. The API enforces both (ADR-0020),
 * and the UI only asks for the reason up front so a drop onto "Lost" completes
 * rather than failing.
 */
export function DealsBoard({ pipeline, search }: { pipeline: PipelineRecord; search: string }) {
  const board = useDealBoard(pipeline.id);
  const move = useMoveDeal();

  const [overStageId, setOverStageId] = useState<string | null>(null);
  const [pendingLost, setPendingLost] = useState<{ deal: DealRecord; to: StageRecord } | null>(
    null,
  );
  // The dragged card, held in a ref because `drop` needs it synchronously and
  // a state update from `dragstart` has not necessarily been applied yet.
  const dragged = useRef<DealRecord | null>(null);

  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);
  const summaries = new Map(board.data?.data.columns.map((column) => [column.stageId, column]));

  const moveDeal = (deal: DealRecord, to: StageRecord, lostReason?: string) => {
    if (deal.stageId === to.id) return;
    move.reset();
    move.mutate({
      deal,
      pipelineId: pipeline.id,
      from: stages.find((stage) => stage.id === deal.stageId),
      to,
      lostReason,
    });
  };

  /** Ask for the reason first when the destination is a lost stage. */
  const requestMove = (deal: DealRecord, to: StageRecord) => {
    if (deal.stageId === to.id) return;
    if (to.stageType === 'lost') {
      setPendingLost({ deal, to });
      return;
    }
    moveDeal(deal, to);
  };

  const onDrop = (event: DragEvent, stage: StageRecord) => {
    event.preventDefault();
    setOverStageId(null);
    const deal = dragged.current;
    dragged.current = null;
    if (deal !== null) requestMove(deal, stage);
  };

  const failure =
    move.error === null
      ? null
      : move.error.code === 'VERSION_CONFLICT'
        ? t('deals.move.conflict')
        : move.error.message || t('deals.move.failed');

  return (
    <div className="space-y-3">
      {failure === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
          {failure}
        </p>
      )}

      <div className="flex gap-4 overflow-x-auto pb-4" data-testid="deals-board">
        {stages.map((stage) => (
          <DealColumn
            key={stage.id}
            pipeline={pipeline}
            stage={stage}
            stages={stages}
            search={search}
            summary={summaries.get(stage.id)}
            over={overStageId === stage.id}
            onDragOver={(event) => {
              // Without preventDefault the browser refuses the drop.
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (overStageId !== stage.id) setOverStageId(stage.id);
            }}
            onDragLeave={() => setOverStageId((current) => (current === stage.id ? null : current))}
            onDrop={(event) => onDrop(event, stage)}
            onDragStart={(deal) => {
              dragged.current = deal;
            }}
            onDragEnd={() => {
              dragged.current = null;
              setOverStageId(null);
            }}
            onMove={requestMove}
          />
        ))}
      </div>

      {pendingLost === null ? null : (
        <LostReasonDialog
          dealName={pendingLost.deal.name ?? t('field.empty')}
          stageName={pendingLost.to.name}
          pending={false}
          onClose={() => setPendingLost(null)}
          onConfirm={(reason) => {
            moveDeal(pendingLost.deal, pendingLost.to, reason);
            setPendingLost(null);
          }}
        />
      )}
    </div>
  );
}

function ColumnTotal({ summary, stage }: { summary: BoardColumn | undefined; stage: StageRecord }) {
  if (summary === undefined) return <Skeleton className="mt-1 h-4 w-24" />;

  const unconverted = summary.unconverted.map((entry) => entry.currency);

  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      <p aria-label={`${stage.name} total`}>
        {summary.count === 1
          ? t('deals.column.deal')
          : t('deals.column.deals', { count: summary.count })}
        {summary.total === null
          ? null
          : ` · ${formatMoney(summary.total.amountMinor, summary.total.currency, DEFAULT_PREFERENCES)}`}
      </p>
      {unconverted.length > 0 ? (
        <p className="text-warning">
          {t('deals.column.unconverted', { currencies: unconverted.join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

function DealColumn({
  pipeline,
  stage,
  stages,
  search,
  summary,
  over,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  pipeline: PipelineRecord;
  stage: StageRecord;
  stages: readonly StageRecord[];
  search: string;
  summary: BoardColumn | undefined;
  over: boolean;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
  onDragStart: (deal: DealRecord) => void;
  onDragEnd: () => void;
  onMove: (deal: DealRecord, to: StageRecord) => void;
}) {
  const query = useStageDeals(pipeline.id, stage.id, search);
  const deals = flattenDealPages(query.data);

  return (
    <section
      aria-label={stage.name}
      data-stage-id={stage.id}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30 p-3 transition-colors',
        over && 'border-primary bg-primary/5',
      )}
    >
      <header className="mb-3">
        <h2 className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="truncate">{stage.name}</span>
          <span className="text-xs font-normal text-muted-foreground">{stage.probability}%</span>
        </h2>
        <ColumnTotal summary={summary} stage={stage} />
      </header>

      {query.isPending ? (
        <div className="space-y-2" role="status" aria-label={t('common.loading')}>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorState
          title={t('deals.error.title')}
          action={
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <ul className="min-h-16 flex-1 space-y-2">
          {deals.length === 0 ? (
            <li className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              {t('deals.column.empty')}
            </li>
          ) : (
            deals.map((deal) => (
              <DealCard
                key={deal.id}
                deal={deal}
                stage={stage}
                stages={stages}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onMove={onMove}
              />
            ))
          )}
          {query.hasNextPage ? (
            <li>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {t('deals.loadMore')}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function DealCard({
  deal,
  stage,
  stages,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  deal: DealRecord;
  stage: StageRecord;
  stages: readonly StageRecord[];
  onDragStart: (deal: DealRecord) => void;
  onDragEnd: () => void;
  onMove: (deal: DealRecord, to: StageRecord) => void;
}) {
  const name = deal.name ?? t('field.empty');

  return (
    <li
      draggable
      data-deal-id={deal.id}
      title={t('deals.card.dragHint')}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        // Firefox will not start a drag that carries no data.
        event.dataTransfer.setData('text/plain', deal.id);
        onDragStart(deal);
      }}
      onDragEnd={onDragEnd}
      className="cursor-grab rounded-md border border-border bg-card p-3 text-sm shadow-sm active:cursor-grabbing"
    >
      <Link
        href={`/deals/${deal.id}`}
        draggable={false}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {name}
      </Link>

      <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {deal.amount == null ? null : (
          <div>
            <dt className="sr-only">{t('deal.amount')}</dt>
            <dd className="text-sm font-medium text-foreground">
              {formatMoney(deal.amount.amountMinor, deal.amount.currency, DEFAULT_PREFERENCES)}
            </dd>
          </div>
        )}
        {deal.expectedCloseDate == null ? null : (
          <div>
            <dt className="sr-only">{t('deal.expectedCloseDate')}</dt>
            <dd>{formatDate(deal.expectedCloseDate, DEFAULT_PREFERENCES)}</dd>
          </div>
        )}
        {deal.lostReason == null ? null : (
          <div>
            <dt className="sr-only">{t('deal.lostReason')}</dt>
            <dd className="italic">{deal.lostReason}</dd>
          </div>
        )}
      </dl>

      <div className="mt-2">
        <Select
          label={t('deals.card.move', { name })}
          labelHidden
          value={stage.id}
          onChange={(event) => {
            const target = stages.find((candidate) => candidate.id === event.target.value);
            if (target !== undefined) onMove(deal, target);
          }}
          className="h-8 text-xs"
        >
          {stages.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </Select>
      </div>
    </li>
  );
}
