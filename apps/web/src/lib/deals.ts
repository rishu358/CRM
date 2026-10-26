'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type { MoneyValue } from './accounts';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';
import { listKey, listSearchParams, type ListParams } from './list-view';

/**
 * Server state for deals and pipelines (CLAUDE.md §9).
 *
 * All fetching lives here rather than in components, so caching, invalidation
 * and the optimistic move are decided once instead of per screen.
 */

export type StageType = 'open' | 'won' | 'lost';

export interface StageRecord {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly probability: number;
  readonly stageType: StageType;
}

export interface PipelineRecord {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly isDefault: boolean;
  readonly stages: readonly StageRecord[];
}

export interface DealPerson {
  readonly contactId: string;
  readonly role: string | null;
}

/**
 * Every business field is optional, and that is not laziness: a field the
 * signed-in user may not read is **absent** from the payload rather than null
 * (CLAUDE.md §5.4), so the type has to be able to say "this key was not sent"
 * as well as "this key is empty".
 */
export interface DealRecord {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly name?: string;
  readonly accountId?: string | null;
  readonly primaryContactId?: string | null;
  readonly pipelineId?: string;
  readonly stageId?: string;
  readonly amount?: MoneyValue | null;
  readonly probability?: number;
  readonly expectedCloseDate?: string | null;
  readonly closedAt?: string | null;
  readonly lostReason?: string | null;
  readonly ownerId?: string | null;
  readonly contacts?: readonly DealPerson[];
  readonly customFields?: Record<string, unknown>;
}

export interface BoardColumn {
  readonly stageId: string;
  readonly count: number;
  /** Null when the caller may not read amounts. */
  readonly total: MoneyValue | null;
  /** Currencies that had no exchange rate, so the total is not short in silence. */
  readonly unconverted: readonly { currency: string; count: number; amountMinor: string }[];
}

export interface BoardRecord {
  readonly pipelineId: string;
  readonly currency: string;
  readonly columns: readonly BoardColumn[];
}

export const dealKeys = {
  all: ['deals'] as const,
  pipelines: ['pipelines'] as const,
  board: (pipelineId: string) => ['deals', 'board', pipelineId] as const,
  columns: (pipelineId: string) => ['deals', 'column', pipelineId] as const,
  column: (pipelineId: string, stageId: string, search: string) =>
    ['deals', 'column', pipelineId, stageId, search] as const,
  list: (pipelineId: string, params: ListParams) =>
    ['deals', 'list', pipelineId, listKey(params)] as const,
  detail: (id: string) => ['deals', 'detail', id] as const,
};

type DealPages = InfiniteData<ListEnvelope<DealRecord>>;

export function usePipelines() {
  return useQuery<ItemEnvelope<PipelineRecord[]>, ApiRequestError>({
    queryKey: dealKeys.pipelines,
    queryFn: () => api.get<ItemEnvelope<PipelineRecord[]>>('/pipelines'),
    // Pipelines change when an admin reshapes them, not while someone drags.
    staleTime: 60_000,
  });
}

/** Column totals for one pipeline, in the tenant's currency. */
export function useDealBoard(pipelineId: string | undefined) {
  return useQuery<ItemEnvelope<BoardRecord>, ApiRequestError>({
    queryKey: dealKeys.board(pipelineId ?? ''),
    queryFn: () =>
      api.get<ItemEnvelope<BoardRecord>>(`/deals/board?pipelineId=${pipelineId ?? ''}`),
    enabled: pipelineId !== undefined,
  });
}

/**
 * The cards of one column: infinite scroll over the keyset cursor (ADR-0012).
 *
 * One query per column rather than one for the whole board, so a column of
 * five hundred deals pages on its own without making the other columns wait
 * for, or share, its cursor.
 */
export function useStageDeals(pipelineId: string, stageId: string, search: string) {
  return useInfiniteQuery<ListEnvelope<DealRecord>, ApiRequestError>({
    queryKey: dealKeys.column(pipelineId, stageId, search),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '25', sort: '-created_at' });
      params.append('filter', `stage_id:eq:${stageId}`);
      if (search.length > 0) params.set('q', search);
      if (typeof pageParam === 'string') params.set('cursor', pageParam);
      return api.get<ListEnvelope<DealRecord>>(`/deals?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor,
  });
}

/** The list view: every deal in a pipeline, in the order the user chose. */
export function useDealList(pipelineId: string, params: ListParams) {
  return useInfiniteQuery<ListEnvelope<DealRecord>, ApiRequestError>({
    queryKey: dealKeys.list(pipelineId, params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = listSearchParams(params, {
        cursor: typeof pageParam === 'string' ? pageParam : null,
        extraFilters: [`pipeline_id:eq:${pipelineId}`],
      });
      return api.get<ListEnvelope<DealRecord>>(`/deals?${query.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor,
    enabled: pipelineId.length > 0,
  });
}

export function useDeal(id: string) {
  return useQuery<ItemEnvelope<DealRecord>, ApiRequestError>({
    queryKey: dealKeys.detail(id),
    queryFn: () => api.get<ItemEnvelope<DealRecord>>(`/deals/${id}`),
  });
}

export function flattenDealPages(data: DealPages | undefined): DealRecord[] {
  return data?.pages.flatMap((page) => page.data) ?? [];
}

/**
 * The newest copy of a deal anywhere in the cache.
 *
 * A move is sent with the version the card was **last confirmed** at, which is
 * not necessarily the version it carried when the user picked it up: a second
 * drag of the same card, started while the first is in flight, has to wait for
 * the first to land and then carry the version the first produced. Reading it
 * at send time rather than capturing it at drag time is what makes two quick
 * drags work instead of the second being refused as a conflict with oneself.
 */
function findCachedDeal(queryClient: QueryClient, id: string): DealRecord | undefined {
  const detail = queryClient.getQueryData<ItemEnvelope<DealRecord>>(dealKeys.detail(id));
  let newest: DealRecord | undefined = detail?.data;

  // Only the paged queries: the board and detail caches under the same prefix
  // hold a different shape, and flattening one of those as pages throws.
  const paged = [
    ...queryClient.getQueriesData<DealPages>({ queryKey: ['deals', 'column'] }),
    ...queryClient.getQueriesData<DealPages>({ queryKey: ['deals', 'list'] }),
  ];
  for (const [, data] of paged) {
    for (const deal of flattenDealPages(data)) {
      if (deal.id === id && (newest === undefined || deal.version > newest.version)) {
        newest = deal;
      }
    }
  }
  return newest;
}

function mapPages(data: DealPages, change: (deals: DealRecord[]) => DealRecord[]): DealPages {
  return { ...data, pages: data.pages.map((page) => ({ ...page, data: change(page.data) })) };
}

/**
 * What a deal looks like once it has been moved, as far as the browser can know.
 *
 * The same rules the API applies (ADR-0020), restated only far enough to paint
 * the card: the server's answer replaces this the moment it arrives, so a
 * disagreement is corrected rather than kept.
 */
function movedDeal(
  deal: DealRecord,
  stage: StageRecord,
  lostReason: string | undefined,
): DealRecord {
  return {
    ...deal,
    stageId: stage.id,
    probability:
      stage.stageType === 'won' ? 100 : stage.stageType === 'lost' ? 0 : stage.probability,
    closedAt: stage.stageType === 'open' ? null : new Date().toISOString(),
    lostReason: stage.stageType === 'lost' ? (lostReason ?? null) : null,
  };
}

export interface MoveDealInput {
  readonly deal: DealRecord;
  readonly pipelineId: string;
  readonly from: StageRecord | undefined;
  readonly to: StageRecord;
  /** Required by the API when `to` is a lost stage. */
  readonly lostReason?: string | undefined;
}

interface MoveContext {
  readonly columns: [readonly unknown[], DealPages | undefined][];
  readonly board: ItemEnvelope<BoardRecord> | undefined;
  readonly detail: ItemEnvelope<DealRecord> | undefined;
}

/**
 * Move a card to another stage — the drag on the Kanban board.
 *
 * Optimistic (MVP_SPEC M5 acceptance: "dragging a deal updates the stage
 * instantly"): the card leaves its column and lands in the new one before the
 * request is sent, and the previous state of every cache touched is kept so a
 * refusal puts it all back. The server's answer then replaces the guess, which
 * is how the card picks up its new `version`.
 *
 * Moves are queued (`scope`), so they reach the API in the order the user made
 * them rather than racing each other for the same version.
 */
export function useMoveDeal() {
  const queryClient = useQueryClient();

  return useMutation<ItemEnvelope<DealRecord>, ApiRequestError, MoveDealInput, MoveContext>({
    // One queue for every move: they reach the API in the order the user made
    // them, each carrying the version the previous one produced.
    scope: { id: 'deal-moves' },
    mutationFn: ({ deal, to, lostReason }) => {
      const latest = findCachedDeal(queryClient, deal.id) ?? deal;
      return api.patch<ItemEnvelope<DealRecord>>(`/deals/${deal.id}`, {
        stageId: to.id,
        ...(lostReason === undefined ? {} : { lostReason }),
        version: latest.version,
      });
    },

    onMutate: async ({ deal, pipelineId, from, to, lostReason }) => {
      await queryClient.cancelQueries({ queryKey: dealKeys.all });

      const columns = queryClient.getQueriesData<DealPages>({
        queryKey: dealKeys.columns(pipelineId),
      });
      const board = queryClient.getQueryData<ItemEnvelope<BoardRecord>>(dealKeys.board(pipelineId));
      const detail = queryClient.getQueryData<ItemEnvelope<DealRecord>>(dealKeys.detail(deal.id));

      const moved = movedDeal(deal, to, lostReason);

      for (const [key, data] of columns) {
        if (data === undefined) continue;
        const isTarget = key[3] === to.id;
        const without = mapPages(data, (rows) => rows.filter((row) => row.id !== deal.id));
        queryClient.setQueryData<DealPages>(
          key,
          isTarget
            ? {
                ...without,
                pages: without.pages.map((page, index) =>
                  index === 0 ? { ...page, data: [moved, ...page.data] } : page,
                ),
              }
            : without,
        );
      }

      // Counts move at once; the totals follow when the server's numbers
      // arrive, because converting an amount needs the tenant's rates.
      if (board !== undefined && from !== undefined && from.id !== to.id) {
        queryClient.setQueryData<ItemEnvelope<BoardRecord>>(dealKeys.board(pipelineId), {
          data: {
            ...board.data,
            columns: board.data.columns.map((column) =>
              column.stageId === from.id
                ? { ...column, count: Math.max(0, column.count - 1) }
                : column.stageId === to.id
                  ? { ...column, count: column.count + 1 }
                  : column,
            ),
          },
        });
      }

      if (detail !== undefined) {
        queryClient.setQueryData<ItemEnvelope<DealRecord>>(dealKeys.detail(deal.id), {
          data: { ...detail.data, ...moved },
        });
      }

      return { columns, board, detail };
    },

    onError: (_error, { deal, pipelineId }, context) => {
      if (context === undefined) return;
      for (const [key, data] of context.columns) {
        queryClient.setQueryData(key, data);
      }
      queryClient.setQueryData(dealKeys.board(pipelineId), context.board);
      queryClient.setQueryData(dealKeys.detail(deal.id), context.detail);
    },

    onSuccess: (result, { deal, pipelineId }) => {
      // The guess is replaced by the record the server wrote: this is where
      // the card gets its new version, so the next drag is not a conflict.
      for (const [key, data] of queryClient.getQueriesData<DealPages>({
        queryKey: dealKeys.columns(pipelineId),
      })) {
        if (data === undefined) continue;
        queryClient.setQueryData<DealPages>(
          key,
          mapPages(data, (rows) => rows.map((row) => (row.id === deal.id ? result.data : row))),
        );
      }
      queryClient.setQueryData(dealKeys.detail(deal.id), result);
    },

    onSettled: (_result, _error, { pipelineId }) => {
      void queryClient.invalidateQueries({ queryKey: dealKeys.board(pipelineId) });
      void queryClient.invalidateQueries({ queryKey: ['deals', 'list'] });
    },
  });
}

export interface UpdateDealInput {
  readonly id: string;
  readonly version: number;
  readonly patch: Record<string, unknown>;
}

/**
 * Inline edit with an optimistic update.
 *
 * The field shows the new value immediately (UX budget: under 100 ms), and the
 * previous value is kept so a rejection can put it back. A stale `version`
 * comes back as 409, which the caller surfaces as "someone else saved first"
 * rather than quietly winning or quietly losing (MVP_SPEC M4).
 */
export function useUpdateDeal() {
  const queryClient = useQueryClient();

  return useMutation<
    ItemEnvelope<DealRecord>,
    ApiRequestError,
    UpdateDealInput,
    { previous: ItemEnvelope<DealRecord> | undefined }
  >({
    mutationFn: ({ id, version, patch }) =>
      api.patch<ItemEnvelope<DealRecord>>(`/deals/${id}`, { ...patch, version }),

    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: dealKeys.detail(id) });
      const previous = queryClient.getQueryData<ItemEnvelope<DealRecord>>(dealKeys.detail(id));

      if (previous !== undefined) {
        queryClient.setQueryData<ItemEnvelope<DealRecord>>(dealKeys.detail(id), {
          data: { ...previous.data, ...patch },
        });
      }
      return { previous };
    },

    onError: (_error, { id }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(dealKeys.detail(id), context.previous);
      }
    },

    onSuccess: (result, { id }) => {
      queryClient.setQueryData(dealKeys.detail(id), result);
      // The board and the list show a subset of the same fields, and an edit
      // to an amount changes a column total — all of it has to be refreshed.
      void queryClient.invalidateQueries({ queryKey: dealKeys.all });
    },
  });
}

export function useCreateDeal() {
  const queryClient = useQueryClient();

  return useMutation<ItemEnvelope<DealRecord>, ApiRequestError, Record<string, unknown>>({
    mutationFn: (body) => api.post<ItemEnvelope<DealRecord>>('/deals', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: dealKeys.all });
    },
  });
}
