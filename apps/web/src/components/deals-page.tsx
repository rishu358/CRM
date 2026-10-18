'use client';

import { Button, EmptyState, ErrorState, NoPermissionState, Select, TableSkeleton } from '@crm/ui';
import { useEffect, useState } from 'react';
import {
  flattenDealPages,
  useCreateDeal,
  useDealBoard,
  useDealList,
  usePipelines,
} from '../lib/deals';
import { t } from '../lib/i18n';
import { consumeIntent, onIntent } from '../lib/palette-intent';
import { AppShell } from './app-shell';
import { DealsBoard } from './deals-board';
import { DealsTable } from './deals-table';
import { NewDealDialog } from './new-deal-dialog';

type View = 'board' | 'list';

/**
 * The deals screen: a Kanban board and a list over the same pipeline.
 *
 * Handles all four required states (CLAUDE.md §9): loading, empty, error and
 * no-permission. The no-permission branch is cosmetic — the API already
 * refused — but a bare error page would leave the user with nothing to do.
 */
export function DealsPage() {
  const [view, setView] = useState<View>('board');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('-created_at');
  const [chosenPipelineId, setChosenPipelineId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const pipelines = usePipelines();
  const create = useCreateDeal();

  /**
   * "New deal" from the command palette (MVP_SPEC M7).
   *
   * Two cases, and both have to work: the palette navigated here from
   * somewhere else, so the intent was left before this component existed; or
   * the user was already on this screen, so it arrives while it is mounted.
   * The first is `consumeIntent` on mount, the second is the subscription.
   */
  useEffect(() => {
    const unsubscribe = onIntent((intent) => {
      if (intent === 'new-deal') setCreating(true);
    });
    // In a microtask rather than inline: setting state synchronously inside an
    // effect makes React render twice before it paints, and the lint rule that
    // says so is right — nothing here is urgent enough to be worth that.
    queueMicrotask(() => {
      if (consumeIntent('new-deal')) setCreating(true);
    });
    return unsubscribe;
  }, []);

  const available = pipelines.data?.data ?? [];
  const pipeline =
    available.find((candidate) => candidate.id === chosenPipelineId) ??
    available.find((candidate) => candidate.isDefault) ??
    available[0];

  const board = useDealBoard(pipeline?.id);
  const list = useDealList(view === 'list' ? (pipeline?.id ?? '') : '', search, sort);
  const listed = flattenDealPages(list.data);

  const boardIsEmpty =
    board.data !== undefined && board.data.data.columns.every((column) => column.count === 0);

  const content = () => {
    if (pipelines.isPending) return <TableSkeleton rows={6} columns={4} />;

    if (pipelines.isError) {
      if (pipelines.error.status === 403) {
        return (
          <NoPermissionState
            title={t('deals.forbidden.title')}
            description={t('deals.forbidden.description')}
          />
        );
      }
      return (
        <ErrorState
          title={t('deals.error.title')}
          description={t('deals.error.description')}
          action={
            <Button variant="outline" onClick={() => void pipelines.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      );
    }

    if (pipeline === undefined) {
      return (
        <EmptyState title={t('deals.empty.title')} description={t('deals.empty.description')} />
      );
    }

    // An empty pipeline offers the first deal; an empty *search* does not, for
    // the reason the accounts list gives: "add your first" to someone who just
    // mistyped a name is unhelpful. The board still renders its columns while
    // searching, because the stages are the point of a board.
    if (boardIsEmpty && search.length === 0) {
      return (
        <EmptyState
          title={t('deals.empty.title')}
          description={t('deals.empty.description')}
          action={<Button onClick={() => setCreating(true)}>{t('deals.empty.action')}</Button>}
        />
      );
    }

    if (view === 'board') return <DealsBoard pipeline={pipeline} search={search} />;

    if (list.isPending) return <TableSkeleton rows={8} columns={5} />;

    if (list.isError) {
      return (
        <ErrorState
          title={t('deals.error.title')}
          description={t('deals.error.description')}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      );
    }

    if (listed.length === 0) {
      return (
        <EmptyState
          title={t('deals.noResults.title')}
          description={t('deals.noResults.description')}
          action={
            <Button variant="outline" onClick={() => setSearch('')}>
              {t('field.cancel')}
            </Button>
          }
        />
      );
    }

    return (
      <div className="space-y-4">
        <DealsTable deals={listed} stages={pipeline.stages} sort={sort} onSortChange={setSort} />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span aria-live="polite">
            {listed.length} {t('deals.count')}
          </span>
          {list.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t('deals.loadMore')}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <AppShell>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{t('deals.title')}</h1>
        <div className="flex flex-wrap items-end gap-2">
          {available.length > 1 && pipeline !== undefined ? (
            <Select
              label={t('deals.pipeline')}
              value={pipeline.id}
              onChange={(event) => setChosenPipelineId(event.target.value)}
              className="w-44"
            >
              {available.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          ) : null}

          <div
            role="group"
            aria-label={t('deals.view')}
            className="flex rounded-md border border-input"
          >
            {(['board', 'list'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={
                  view === option
                    ? 'h-9 bg-accent px-3 text-sm font-medium text-accent-foreground'
                    : 'h-9 px-3 text-sm text-muted-foreground hover:bg-accent'
                }
              >
                {option === 'board' ? t('deals.view.board') : t('deals.view.list')}
              </button>
            ))}
          </div>

          <label className="sr-only" htmlFor="deal-search">
            {t('deals.search')}
          </label>
          <input
            id="deal-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('deals.searchPlaceholder')}
            className="h-9 w-48 rounded-md border border-input bg-background px-3 text-sm"
          />
          <Button onClick={() => setCreating(true)} disabled={pipeline === undefined}>
            {t('deals.new')}
          </Button>
        </div>
      </header>

      {content()}

      {creating && pipeline !== undefined ? (
        <NewDealDialog
          pipelineId={pipeline.id}
          defaultCurrency={board.data?.data.currency ?? 'INR'}
          pending={create.isPending}
          error={create.error}
          onClose={() => {
            setCreating(false);
            create.reset();
          }}
          onSubmit={(values) => {
            create.mutate(values, { onSuccess: () => setCreating(false) });
          }}
        />
      ) : null}
    </AppShell>
  );
}
