'use client';

import type {
  SavedView,
  SavedViewCreateInput,
  SavedViewObjectType,
  SavedViewUpdateInput,
} from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for saved views (CLAUDE.md §9, MVP_SPEC M4, ADR-0056).
 *
 * The API decides who sees which view and which fields a view may use; this file only asks.
 * A view is applied by the caller putting its conditions into the ordinary list request, so a
 * saved view never has a path of its own to the data.
 */

export type { SavedView, SavedViewObjectType };

export const savedViewKeys = {
  all: ['saved-views'] as const,
  list: (objectType: SavedViewObjectType) => ['saved-views', objectType] as const,
};

export function useSavedViews(objectType: SavedViewObjectType) {
  return useQuery<ItemEnvelope<SavedView[]>, ApiRequestError>({
    queryKey: savedViewKeys.list(objectType),
    queryFn: () => api.get<ItemEnvelope<SavedView[]>>(`/saved-views?objectType=${objectType}`),
    // A refusal is an answer; retrying it only delays the screen that explains it.
    retry: (count, error) => error.status !== 403 && error.status !== 401 && count < 2,
  });
}

function useAfterChange() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: savedViewKeys.all });
}

export function useCreateSavedView() {
  const afterChange = useAfterChange();
  return useMutation<ItemEnvelope<SavedView>, ApiRequestError, SavedViewCreateInput>({
    mutationFn: (input) => api.post<ItemEnvelope<SavedView>>('/saved-views', input),
    onSuccess: afterChange,
  });
}

export function useUpdateSavedView() {
  const afterChange = useAfterChange();
  return useMutation<
    ItemEnvelope<SavedView>,
    ApiRequestError,
    { id: string; input: SavedViewUpdateInput }
  >({
    mutationFn: ({ id, input }) => api.patch<ItemEnvelope<SavedView>>(`/saved-views/${id}`, input),
    onSuccess: afterChange,
  });
}

export function useDeleteSavedView() {
  const afterChange = useAfterChange();
  return useMutation<void, ApiRequestError, { id: string; version: number }>({
    mutationFn: ({ id, version }) => api.delete<void>(`/saved-views/${id}?version=${version}`),
    onSuccess: afterChange,
  });
}
