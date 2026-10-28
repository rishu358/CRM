'use client';

import { TAG_COLORS, TAG_NAME_MAX, type BusinessObjectType, type TagColor } from '@crm/core';
import type { BulkResult, RecordTag, TagUsage, TagUpdateInput } from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';
import type { TranslationKey } from './i18n';

/**
 * Server state for tags (CLAUDE.md §9, ADR-0063).
 *
 * The workspace's tag list for pickers and filters comes from `useTags` in `bulk.ts` (the same
 * `['tags']` cache entry, so an edit here refreshes every picker). Adding and removing a tag on one
 * record is the bulk action with one id, so a record page gets the cap, the audit entry and the
 * permission check the lists already have.
 */

export type { RecordTag, TagUsage };

export const TAG_COLOR_LABELS: Readonly<Record<TagColor, TranslationKey>> = {
  gray: 'tags.color.gray',
  red: 'tags.color.red',
  orange: 'tags.color.orange',
  amber: 'tags.color.amber',
  green: 'tags.color.green',
  teal: 'tags.color.teal',
  blue: 'tags.color.blue',
  violet: 'tags.color.violet',
};

export { TAG_COLORS, TAG_NAME_MAX };

export const tagKeys = {
  all: ['tags'] as const,
  usage: ['tags', 'usage'] as const,
};

/** Every tag with how many records carry it. For people who manage tags; a 403 for everyone else. */
export function useTagUsage() {
  return useQuery<ItemEnvelope<TagUsage[]>, ApiRequestError>({
    queryKey: tagKeys.usage,
    queryFn: () => api.get<ItemEnvelope<TagUsage[]>>('/tags/usage'),
    retry: (count, error) => error.status !== 403 && error.status !== 401 && count < 2,
  });
}

/** Tag or untag one record: the bulk action with a single id. */
export function useChangeRecordTags(objectType: BusinessObjectType, recordId: string) {
  const client = useQueryClient();
  return useMutation<
    BulkResult,
    ApiRequestError,
    { action: 'tag_add' | 'tag_remove'; name: string }
  >({
    mutationFn: async ({ action, name }) => {
      const response = await api.post<ItemEnvelope<BulkResult>>(
        '/bulk-actions',
        {
          objectType,
          action,
          tags: [name],
          dryRun: false,
          target: { kind: 'ids', ids: [recordId] },
        },
        { 'idempotency-key': `tag-${globalThis.crypto.randomUUID()}` },
      );
      return response.data;
    },
    onSettled: () => {
      // The record, its list row and the picker all show tags now.
      void client.invalidateQueries();
    },
  });
}

export function useUpdateTag() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<unknown>, ApiRequestError, { id: string; input: TagUpdateInput }>(
    {
      mutationFn: ({ id, input }) => api.patch<ItemEnvelope<unknown>>(`/tags/${id}`, input),
      onSuccess: () => void client.invalidateQueries(),
    },
  );
}

export function useDeleteTag() {
  const client = useQueryClient();
  return useMutation<void, ApiRequestError, { id: string; version: number }>({
    mutationFn: ({ id, version }) => api.delete<void>(`/tags/${id}?version=${version}`),
    onSuccess: () => void client.invalidateQueries(),
  });
}

/** What the person sees as a reason a tag change did not happen. */
export function skippedReason(result: BulkResult): 'not_permitted' | 'not_found' | null {
  const skipped = result.skipped[0];
  if (skipped === undefined) return null;
  return skipped.reason === 'not_permitted' ? 'not_permitted' : 'not_found';
}

export function totalRecords(usage: TagUsage): number {
  const { contact, account, lead, deal } = usage.records;
  return contact + account + lead + deal;
}
