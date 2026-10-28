'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';
import type { DuplicateMatch } from './leads';
import { listKey, listSearchParams, type ListParams } from './list-view';
import type { RecordTag } from './tags';

/**
 * Server state for accounts (CLAUDE.md §9).
 *
 * All fetching lives here rather than in components, so caching, invalidation
 * and optimistic updates are decided once instead of per screen.
 */

/** An amount as it travels: minor units in a string, never a float. */
export interface MoneyValue {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface AddressValue {
  readonly line1?: string | null;
  readonly line2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string | null;
}

/**
 * Every business field is optional, and that is not laziness.
 *
 * A field the signed-in user may not read is **absent** from the payload
 * rather than null (CLAUDE.md §5.4), so the type has to be able to say
 * "this key was not sent" as well as "this key is empty".
 */
export interface AccountRecord {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly name?: string;
  readonly domain?: string | null;
  readonly industry?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly website?: string | null;
  readonly gstin?: string | null;
  readonly billingAddress?: AddressValue | null;
  readonly shippingAddress?: AddressValue | null;
  readonly annualRevenue?: MoneyValue | null;
  readonly employeeCount?: number | null;
  readonly parentAccountId?: string | null;
  readonly ownerId?: string | null;
  readonly customFields?: Record<string, unknown>;
  /** The tags on the record, by name (ADR-0063). */
  readonly tags?: readonly RecordTag[];
}

export const accountKeys = {
  all: ['accounts'] as const,
  list: (params: ListParams) => ['accounts', 'list', listKey(params)] as const,
  detail: (id: string) => ['accounts', 'detail', id] as const,
};

/**
 * Infinite scroll over the keyset cursor (ADR-0012).
 *
 * `sort` is part of the query key: changing the ordering changes the cursor
 * sequence entirely, so the cached pages of the previous sort are not a prefix
 * of the new one and must not be reused.
 */
export function useAccountList(params: ListParams) {
  return useInfiniteQuery<ListEnvelope<AccountRecord>, ApiRequestError>({
    queryKey: accountKeys.list(params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = listSearchParams(params, {
        cursor: typeof pageParam === 'string' ? pageParam : null,
      });
      return api.get<ListEnvelope<AccountRecord>>(`/accounts?${query.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor,
  });
}

export function useAccount(id: string) {
  return useQuery<ItemEnvelope<AccountRecord>, ApiRequestError>({
    queryKey: accountKeys.detail(id),
    queryFn: () => api.get<ItemEnvelope<AccountRecord>>(`/accounts/${id}`),
  });
}

export interface UpdateAccountInput {
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
export function useUpdateAccount() {
  const queryClient = useQueryClient();

  return useMutation<
    ItemEnvelope<AccountRecord>,
    ApiRequestError,
    UpdateAccountInput,
    { previous: ItemEnvelope<AccountRecord> | undefined }
  >({
    mutationFn: ({ id, version, patch }) =>
      api.patch<ItemEnvelope<AccountRecord>>(`/accounts/${id}`, { ...patch, version }),

    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: accountKeys.detail(id) });
      const previous = queryClient.getQueryData<ItemEnvelope<AccountRecord>>(
        accountKeys.detail(id),
      );

      if (previous !== undefined) {
        queryClient.setQueryData<ItemEnvelope<AccountRecord>>(accountKeys.detail(id), {
          data: { ...previous.data, ...patch },
        });
      }
      return { previous };
    },

    onError: (_error, { id }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(accountKeys.detail(id), context.previous);
      }
    },

    onSuccess: (result, { id }) => {
      queryClient.setQueryData(accountKeys.detail(id), result);
      // The list shows a subset of the same fields, so it has to be refreshed
      // too — otherwise an edit appears on the record page and not in the table.
      void queryClient.invalidateQueries({ queryKey: accountKeys.all });
    },
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();

  return useMutation<ItemEnvelope<AccountRecord>, ApiRequestError, Record<string, unknown>>({
    mutationFn: (body) => api.post<ItemEnvelope<AccountRecord>>('/accounts', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.all });
    },
  });
}

/**
 * "Would this account duplicate something?", asked before the save so the prompt appears while the
 * person can still change their mind (ADR-0023). A failed check must never stand between a person and
 * saving: the API reports matches again with the save regardless.
 */
export function useCheckAccountDuplicates() {
  return useMutation<ItemEnvelope<DuplicateMatch[]>, ApiRequestError, Record<string, unknown>>({
    mutationFn: (body) =>
      api.post<ItemEnvelope<DuplicateMatch[]>>('/accounts/duplicate-check', body),
  });
}

/** Flatten infinite-query pages into one list for rendering. */
export function flattenAccountPages(
  data: InfiniteData<ListEnvelope<AccountRecord>> | undefined,
): AccountRecord[] {
  return data?.pages.flatMap((page) => page.data) ?? [];
}
