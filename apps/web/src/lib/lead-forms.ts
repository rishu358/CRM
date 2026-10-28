'use client';

import type {
  LeadForm,
  LeadFormCreateInput,
  LeadFormIssued,
  LeadFormRevokeInput,
  LeadFormRotateInput,
  LeadFormSetup,
  LeadFormUpdateInput,
} from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for the web form administration (CLAUDE.md §9, ADR-0063).
 *
 * Nothing here decides who may manage forms: a 403 on the list is the answer that hides the screen,
 * and the API refuses every write on its own. A key is only ever in the answer to the call that made
 * it (`LeadFormIssued`); it is held in component state long enough to be copied and is never put in
 * the query cache, so no later read, refetch or devtools panel can show it again.
 */

export type { LeadForm, LeadFormIssued, LeadFormSetup };

export const leadFormKeys = {
  all: ['lead-forms'] as const,
  list: ['lead-forms', 'list'] as const,
  setup: ['lead-forms', 'setup'] as const,
};

/** A refusal is an answer; retrying it only delays the screen that explains it. */
function retry(count: number, error: ApiRequestError): boolean {
  return error.status !== 403 && error.status !== 401 && count < 2;
}

export function useLeadForms() {
  return useQuery<ItemEnvelope<LeadForm[]>, ApiRequestError>({
    queryKey: leadFormKeys.list,
    queryFn: () => api.get<ItemEnvelope<LeadForm[]>>('/lead-forms'),
    retry,
  });
}

export function useLeadFormSetup() {
  return useQuery<ItemEnvelope<LeadFormSetup>, ApiRequestError>({
    queryKey: leadFormKeys.setup,
    queryFn: () => api.get<ItemEnvelope<LeadFormSetup>>('/lead-forms/setup'),
    retry,
  });
}

function useInvalidating<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation<TResult, ApiRequestError, TInput>({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: leadFormKeys.all }),
  });
}

export function useCreateLeadForm() {
  return useInvalidating(
    async (input: LeadFormCreateInput) =>
      (await api.post<ItemEnvelope<LeadFormIssued>>('/lead-forms', input)).data,
  );
}

export function useUpdateLeadForm(id: string) {
  return useInvalidating(
    async (input: LeadFormUpdateInput) =>
      (await api.patch<ItemEnvelope<LeadForm>>(`/lead-forms/${id}`, input)).data,
  );
}

export function useDeleteLeadForm(id: string) {
  return useInvalidating(async (version: number) => {
    await api.delete<void>(`/lead-forms/${id}?version=${version}`);
  });
}

export function useRotateLeadFormKey(id: string) {
  return useInvalidating(
    async (input: LeadFormRotateInput) =>
      (await api.post<ItemEnvelope<LeadFormIssued>>(`/lead-forms/${id}/key/rotate`, input)).data,
  );
}

export function useRevokeLeadFormKeys(id: string) {
  return useInvalidating(
    async (input: LeadFormRevokeInput) =>
      (await api.post<ItemEnvelope<LeadForm>>(`/lead-forms/${id}/key/revoke`, input)).data,
  );
}

export function usePauseLeadForms() {
  return useInvalidating(
    async (paused: boolean) =>
      (await api.post<ItemEnvelope<LeadFormSetup>>('/lead-forms/pause', { paused })).data,
  );
}
