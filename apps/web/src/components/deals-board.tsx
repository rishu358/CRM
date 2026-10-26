'use client';

import { Button, DueIcon, ErrorState, IconSelect, MoveIcon, Skeleton, cn } from '@crm/ui';
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
 *
 * Layout. From `lg` up every stage is a column and they share the width, each
 * with a floor so a card never gets narrower than it can be read. Below that, a
 * row of five columns is not a board, it is a scrollbar — so the screen shows
 * one stage at a time, with a switcher that carries each stage's count. The
 * switcher changes what is *displayed*; every column is still mounted and still
 * fetching its own page, so switching is instant.
 */

/**
 * Open stages narrow like a funnel, and the accent says how far along: the
 * first stage is the faintest teal and the last open one is solid. Won and lost
 * keep their meaning colours.
 */
const OPEN_TINTS = [
  'bg-primary/25',
  'bg-primary/40',
  'bg-primary/55',
  'bg-primary/75',
  'bg-primary',
];

function stageAccent(stage: StageRecord, openIndex: number, openCount: number): string {
  if (stage.stageType === 'won') return 'bg-success';
  if (stage.stageType === 'lost') return 'bg-destructive';
  const step =
    openCount <= 1
      ? OPEN_TINTS.length - 1
      : Math.round((openIndex / (openCount - 1)) * (OPEN_TINTS.length - 1));
  return OPEN_TINTS[step] ?? 'bg-primary';
}

export function DealsBoard({ pipeline, search }: { pipeline: PipelineRecord; search: string }) {
  const board = useDealBoard(pipeline.id);
  const move = useMoveDeal();

  const [overStageId, setOverStageId] = useState<string | null>(null);
  const [shownStageId, setShownStageId] = useState<string | null>(null);
  const [pendingLost, setPendingLost] = useState<{ deal: DealRecord; to: StageRecord } | null>(
    null,
  );
  // The dragged card, held in a ref because `drop` needs it synchronously and
  // a state update from `dragstart` has not necessarily been applied yet.
  const dragged = useRef<DealRecord | null>(null);

  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);
  const summaries = new Map(board.data?.data.columns.map((column) => [column.stageId, column]));
  const openStages = stages.filter((stage) => stage.stageType === 'open');
  const shownId = shownStageId ?? stages[0]?.id ?? null;

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
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          {failure}
        </p>
      )}

      {/* Narrow screens: pick the stage to look at. Hidden from `lg` up. */}
      <div
        role="group"
        aria-label={t('deals.board.showStage')}
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden"
      >
        {stages.map((stage) => {
          const selected = stage.id === shownId;
          const count = summaries.get(stage.id)?.count;
          return (
            <button
              key={stage.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setShownStageId(stage.id)}
              className={cn(
                'inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm transition-colors duration-fast',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-card text-foreground hover:bg-accent',
              )}
            >
              {stage.name}
              {count === undefined ? null : (
                <span
                  className={cn(
                    'figures rounded-full px-1.5 text-xs font-medium',
                    selected
                      ? 'bg-primary-foreground/20'
                      : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/*
        `relative` is load-bearing. Cards hold visually-hidden text (`sr-only`
        is `position: absolute`), and an absolutely positioned child escapes an
        `overflow` box unless something between it and the box is positioned.
        Without this, the labels inside columns scrolled out of view still
        counted toward the page's width and gave the whole screen a sideways
        scrollbar.
      */}
      <div className="relative flex gap-3 overflow-x-auto pb-3 lg:snap-x" data-testid="deals-board">
        {stages.map((stage) => (
          <DealColumn
            key={stage.id}
            pipeline={pipeline}
            stage={stage}
            stages={stages}
            search={search}
            summary={summaries.get(stage.id)}
            accent={stageAccent(stage, openStages.indexOf(stage), openStages.length)}
            shown={stage.id === shownId}
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
  if (summary === undefined) return <Skeleton className="mt-2 h-5 w-28" />;

  const unconverted = summary.unconverted.map((entry) => entry.currency);

  return (
    <div className="mt-1.5 space-y-0.5">
      {/*
        Money first, count second: the figure is what a salesperson scans a
        board for, and the count is context for it.
      */}
      <p aria-label={`${stage.name} total`} className="figures text-sm text-muted-foreground">
        {summary.total === null ? null : (
          <span className="text-base font-semibold text-foreground">
            {formatMoney(summary.total.amountMinor, summary.total.currency, DEFAULT_PREFERENCES)}
          </span>
        )}
        {summary.total === null ? null : ' · '}
        {summary.count === 1
          ? t('deals.column.deal')
          : t('deals.column.deals', { count: summary.count })}
      </p>
      {unconverted.length > 0 ? (
        <p className="text-xs text-warning">
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
  accent,
  shown,
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
  accent: string;
  /** On narrow screens only the shown stage is visible; from `lg` all are. */
  shown: boolean;
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
        'min-w-0 flex-col overflow-hidden rounded-xl border bg-muted transition-colors duration-fast',
        'w-full lg:min-w-[13rem] lg:flex-1 lg:basis-0 lg:snap-start',
        shown ? 'flex' : 'hidden lg:flex',
        over ? 'border-primary bg-accent' : 'border-border',
      )}
    >
      <span aria-hidden="true" className={cn('h-1 w-full shrink-0', accent)} />

      <header className="px-3 pb-2 pt-3">
        <h2 className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="truncate">{stage.name}</span>
          <span className="figures shrink-0 text-xs font-normal text-muted-foreground">
            {stage.probability}%
          </span>
        </h2>
        <ColumnTotal summary={summary} stage={stage} />
      </header>

      <div className="flex-1 px-2 pb-2">
        {query.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
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
          <ul className="flex min-h-20 flex-col gap-2 md:grid md:grid-cols-2 lg:flex lg:flex-col">
            {deals.length === 0 ? (
              <li
                className={cn(
                  'rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground md:col-span-2 lg:col-span-1',
                  over ? 'border-primary' : 'border-input/70',
                )}
              >
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
              <li className="md:col-span-2 lg:col-span-1">
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
      </div>
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
  const [dragging, setDragging] = useState(false);

  return (
    <li
      draggable
      data-deal-id={deal.id}
      title={t('deals.card.dragHint')}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        // Firefox will not start a drag that carries no data.
        event.dataTransfer.setData('text/plain', deal.id);
        setDragging(true);
        onDragStart(deal);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragEnd();
      }}
      className={cn(
        'group cursor-grab rounded-lg border border-border bg-card p-3 text-sm shadow-sm',
        'transition-[box-shadow,border-color,opacity] duration-fast',
        'hover:border-input hover:shadow-md focus-within:border-input focus-within:shadow-md',
        'active:cursor-grabbing',
        dragging && 'opacity-50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/deals/${deal.id}`}
          draggable={false}
          className="min-w-0 rounded-sm font-medium leading-5 text-foreground underline-offset-4 hover:text-primary hover:underline"
        >
          <span className="line-clamp-2">{name}</span>
        </Link>
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <dl className="min-w-0 space-y-1">
          {deal.amount == null ? null : (
            <div>
              <dt className="sr-only">{t('deal.amount')}</dt>
              <dd className="figures text-base font-semibold text-foreground">
                {formatMoney(deal.amount.amountMinor, deal.amount.currency, DEFAULT_PREFERENCES)}
              </dd>
            </div>
          )}
          {deal.expectedCloseDate == null ? null : (
            <div>
              <dt className="sr-only">{t('deal.expectedCloseDate')}</dt>
              <dd className="figures flex items-center gap-1.5 text-xs text-muted-foreground">
                <DueIcon aria-hidden="true" className="h-3.5 w-3.5" />
                {formatDate(deal.expectedCloseDate, DEFAULT_PREFERENCES)}
              </dd>
            </div>
          )}
          {deal.lostReason == null ? null : (
            <div>
              <dt className="sr-only">{t('deal.lostReason')}</dt>
              <dd className="text-xs italic text-muted-foreground">{deal.lostReason}</dd>
            </div>
          )}
        </dl>

        {/*
          The keyboard and touch path for a move, so it is always present — a
          small icon, not a menu on every card. It is a real select underneath:
          the label, the arrow keys and the phone's own picker all work.
        */}
        <IconSelect
          label={t('deals.card.move', { name })}
          icon={<MoveIcon className="h-4 w-4" />}
          value={stage.id}
          onChange={(event) => {
            const target = stages.find((candidate) => candidate.id === event.target.value);
            if (target !== undefined) onMove(deal, target);
          }}
        >
          {stages.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </IconSelect>
      </div>
    </li>
  );
}
