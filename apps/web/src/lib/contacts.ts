'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';
import { listKey, listSearchParams, type ListParams } from './list-view';

/**
 * Server state for contacts (CLAUDE.md §9).
 *
 * All fetching lives here rather than in components, so caching, invalidation
 * and optimistic updates are decided once instead of per screen.
 */
export interface ContactRecord {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly firstName?: string | null;
  readonly lastName?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly whatsapp?: string | null;
  readonly title?: string | null;
  readonly leadSource?: string | null;
  readonly ownerId?: string | null;
  readonly customFields?: Record<string, unknown>;
}

export const contactKeys = {
  all: ['contacts'] as const,
  list: (params: ListParams) => ['contacts', 'list', listKey(params)] as const,
  detail: (id: string) => ['contacts', 'detail', id] as const,
};

/** Infinite scroll over the keyset cursor (ADR-0012). */
export function useContactList(params: ListParams) {
  return useInfiniteQuery<ListEnvelope<ContactRecord>, ApiRequestError>({
    queryKey: contactKeys.list(params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = listSearchParams(params, {
        cursor: typeof pageParam === 'string' ? pageParam : null,
      });
      return api.get<ListEnvelope<ContactRecord>>(`/contacts?${query.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor,
  });
}

export function useContact(id: string) {
  return useQuery<ItemEnvelope<ContactRecord>, ApiRequestError>({
    queryKey: contactKeys.detail(id),
    queryFn: () => api.get<ItemEnvelope<ContactRecord>>(`/contacts/${id}`),
  });
}

export interface UpdateContactInput {
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
export function useUpdateContact() {
  const queryClient = useQueryClient();

  return useMutation<
    ItemEnvelope<ContactRecord>,
    ApiRequestError,
    UpdateContactInput,
    { previous: ItemEnvelope<ContactRecord> | undefined }
  >({
    mutationFn: ({ id, version, patch }) =>
      api.patch<ItemEnvelope<ContactRecord>>(`/contacts/${id}`, { ...patch, version }),

    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: contactKeys.detail(id) });
      const previous = queryClient.getQueryData<ItemEnvelope<ContactRecord>>(
        contactKeys.detail(id),
      );

      if (previous !== undefined) {
        queryClient.setQueryData<ItemEnvelope<ContactRecord>>(contactKeys.detail(id), {
          data: { ...previous.data, ...patch },
        });
      }
      return { previous };
    },

    onError: (_error, { id }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(contactKeys.detail(id), context.previous);
      }
    },

    onSuccess: (result, { id }) => {
      queryClient.setQueryData(contactKeys.detail(id), result);
      // The list shows a subset of the same fields, so it has to be refreshed
      // too — otherwise an edit appears on the record page and not in the table.
      void queryClient.invalidateQueries({ queryKey: contactKeys.all });
    },
  });
}

export function useCreateContact() {
  const queryClient = useQueryClient();

  return useMutation<ItemEnvelope<ContactRecord>, ApiRequestError, Record<string, unknown>>({
    mutationFn: (body) => api.post<ItemEnvelope<ContactRecord>>('/contacts', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contactKeys.all });
    },
  });
}

/** Flatten infinite-query pages into one list for rendering. */
export function flattenPages(
  data: InfiniteData<ListEnvelope<ContactRecord>> | undefined,
): ContactRecord[] {
  return data?.pages.flatMap((page) => page.data) ?? [];
}
