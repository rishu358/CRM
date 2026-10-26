'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';

/**
 * Server state for leads (CLAUDE.md §9).
 *
 * All fetching lives here rather than in components, so caching, invalidation
 * and optimistic updates are decided once instead of per screen.
 */
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'unqualified' | 'converted';

/** The statuses a person may pick. `converted` is set only by converting. */
export const OPEN_LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;

/**
 * Every business field is optional, and that is not laziness: a field the
 * signed-in user may not read is **absent** from the payload rather than null
 * (CLAUDE.md §5.4), so the type has to say "this key was not sent" as well as
 * "this key is empty".
 */
export interface LeadRecord {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly firstName?: string | null;
  readonly lastName?: string;
  readonly company?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly source?: string | null;
  readonly status?: LeadStatus;
  readonly ownerId?: string | null;
  readonly convertedAt?: string | null;
  readonly convertedContactId?: string | null;
  readonly convertedAccountId?: string | null;
  readonly convertedDealId?: string | null;
  readonly customFields?: Record<string, unknown>;
}

export interface DuplicateMatch {
  readonly objectType: 'lead' | 'contact' | 'account';
  readonly id: string;
  readonly label: string;
  readonly matchedOn: readonly ('email' | 'phone' | 'domain' | 'name')[];
}

export interface ConvertedRecord {
  readonly id: string;
  readonly created: boolean;
}

export interface ConversionResult {
  readonly lead: LeadRecord;
  readonly contact: ConvertedRecord;
  readonly account: ConvertedRecord | null;
  readonly deal: { readonly id: string } | null;
  readonly skippedFields: readonly string[];
}

export type ContactChoice =
  { readonly mode: 'create' } | { readonly mode: 'link'; readonly contactId: string };

export type AccountChoice =
  | { readonly mode: 'create' }
  | { readonly mode: 'link'; readonly accountId: string }
  | { readonly mode: 'none' };

export interface ConvertInput {
  readonly id: string;
  readonly version: number;
  readonly contact: ContactChoice;
  readonly account: AccountChoice;
  readonly dealName: string | null;
  readonly acknowledgeDuplicates: boolean;
}

export const leadKeys = {
  all: ['leads'] as const,
  list: (search: string) => ['leads', 'list', search] as const,
  detail: (id: string) => ['leads', 'detail', id] as const,
  matches: (id: string) => ['leads', 'conversion-matches', id] as const,
};

/** Infinite scroll over the keyset cursor (ADR-0012). */
export function useLeadList(search: string) {
  return useInfiniteQuery<ListEnvelope<LeadRecord>, ApiRequestError>({
    queryKey: leadKeys.list(search),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50', sort: '-created_at' });
      if (search.length > 0) params.set('q', search);
      if (typeof pageParam === 'string') params.set('cursor', pageParam);
      return api.get<ListEnvelope<LeadRecord>>(`/leads?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.meta.nextCursor,
  });
}

export function useLead(id: string) {
  return useQuery<ItemEnvelope<LeadRecord>, ApiRequestError>({
    queryKey: leadKeys.detail(id),
    queryFn: () => api.get<ItemEnvelope<LeadRecord>>(`/leads/${id}`),
  });
}

export interface UpdateLeadInput {
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
export function useUpdateLead() {
  const queryClient = useQueryClient();

  return useMutation<
    ItemEnvelope<LeadRecord>,
    ApiRequestError,
    UpdateLeadInput,
    { previous: ItemEnvelope<LeadRecord> | undefined }
  >({
    mutationFn: ({ id, version, patch }) =>
      api.patch<ItemEnvelope<LeadRecord>>(`/leads/${id}`, { ...patch, version }),

    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: leadKeys.detail(id) });
      const previous = queryClient.getQueryData<ItemEnvelope<LeadRecord>>(leadKeys.detail(id));
      if (previous !== undefined) {
        queryClient.setQueryData<ItemEnvelope<LeadRecord>>(leadKeys.detail(id), {
          data: { ...previous.data, ...patch },
        });
      }
      return { previous };
    },

    onError: (_error, { id }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(leadKeys.detail(id), context.previous);
      }
    },

    onSuccess: (result, { id }) => {
      queryClient.setQueryData(leadKeys.detail(id), result);
      void queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

/** A created lead, with whatever it might duplicate. */
export interface CreatedLead extends ItemEnvelope<LeadRecord> {
  readonly meta?: { readonly duplicates?: readonly DuplicateMatch[] };
}

export function useCreateLead() {
  const queryClient = useQueryClient();

  return useMutation<CreatedLead, ApiRequestError, Record<string, unknown>>({
    mutationFn: (body) => api.post<CreatedLead>('/leads', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leadKeys.all });
    },
  });
}

/**
 * "Would this duplicate something?", asked before the save so the prompt
 * appears while the person can still change their mind (ADR-0023).
 */
export function useCheckDuplicates() {
  return useMutation<ItemEnvelope<DuplicateMatch[]>, ApiRequestError, Record<string, unknown>>({
    mutationFn: (body) => api.post<ItemEnvelope<DuplicateMatch[]>>('/leads/duplicate-check', body),
  });
}

/** The "link to existing" choices for one lead's conversion. */
export function useConversionMatches(id: string) {
  return useQuery<ItemEnvelope<DuplicateMatch[]>, ApiRequestError>({
    queryKey: leadKeys.matches(id),
    queryFn: () => api.get<ItemEnvelope<DuplicateMatch[]>>(`/leads/${id}/conversion-matches`),
    // A stale list could offer a record that has since been deleted or merged.
    staleTime: 0,
    gcTime: 0,
  });
}

export function useConvertLead() {
  const queryClient = useQueryClient();

  return useMutation<ItemEnvelope<ConversionResult>, ApiRequestError, ConvertInput>({
    mutationFn: ({ id, version, contact, account, dealName, acknowledgeDuplicates }) =>
      api.post<ItemEnvelope<ConversionResult>>(`/leads/${id}/convert`, {
        version,
        contact,
        account,
        deal: dealName === null ? null : { name: dealName },
        acknowledgeDuplicates,
      }),
    onSuccess: (_result, { id }) => {
      void queryClient.invalidateQueries({ queryKey: leadKeys.all });
      void queryClient.invalidateQueries({ queryKey: leadKeys.detail(id) });
      // Conversion creates records in three other lists.
      for (const key of ['contacts', 'accounts', 'deals']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/** Flatten infinite-query pages into one list for rendering. */
export function flattenLeadPages(
  data: InfiniteData<ListEnvelope<LeadRecord>> | undefined,
): LeadRecord[] {
  return data?.pages.flatMap((page) => page.data) ?? [];
}
