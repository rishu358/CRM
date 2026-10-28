'use client';

import type {
  AssignmentOverview,
  AssignmentRule,
  AssignmentRuleCreateInput,
  AssignmentRuleOrderInput,
  AssignmentRuleUpdateInput,
  AssignmentSettingsUpdateInput,
  AssignmentTestInput,
  AssignmentTestResult,
} from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for the lead assignment rules (CLAUDE.md §9, ADR-0065 10).
 *
 * Every write answers with the whole overview (or the rule it changed), so the screen redraws from one
 * answer. Nothing here decides who may edit: a 403 on the overview hides the screen and the API
 * refuses every write on its own. Testing a sample lead is a POST that reads only, and is never cached.
 */

export type { AssignmentOverview, AssignmentRule, AssignmentTestResult };

export const assignmentKeys = { all: ['lead-assignment'] as const };

function retry(count: number, error: ApiRequestError): boolean {
  return error.status !== 403 && error.status !== 401 && count < 2;
}

export function useAssignmentOverview() {
  return useQuery<ItemEnvelope<AssignmentOverview>, ApiRequestError>({
    queryKey: assignmentKeys.all,
    queryFn: () => api.get<ItemEnvelope<AssignmentOverview>>('/lead-assignment'),
    retry,
  });
}

function useWrite<TInput, TResult>(run: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation<TResult, ApiRequestError, TInput>({
    mutationFn: run,
    onSuccess: () => client.invalidateQueries({ queryKey: assignmentKeys.all }),
  });
}

export function useCreateRule() {
  return useWrite(
    async (input: AssignmentRuleCreateInput) =>
      (await api.post<ItemEnvelope<AssignmentOverview>>('/lead-assignment/rules', input)).data,
  );
}

export function useUpdateRule(id: string) {
  return useWrite(
    async (input: AssignmentRuleUpdateInput) =>
      (await api.patch<ItemEnvelope<AssignmentRule>>(`/lead-assignment/rules/${id}`, input)).data,
  );
}

export function useDeleteRule() {
  return useWrite(async (input: { id: string; version: number }) => {
    await api.delete<void>(`/lead-assignment/rules/${input.id}?version=${input.version}`);
  });
}

export function useOrderRules() {
  return useWrite(
    async (input: AssignmentRuleOrderInput) =>
      (await api.post<ItemEnvelope<AssignmentOverview>>('/lead-assignment/rules/order', input))
        .data,
  );
}

export function useUpdateAssignmentSettings() {
  return useWrite(
    async (input: AssignmentSettingsUpdateInput) =>
      (await api.patch<ItemEnvelope<AssignmentOverview>>('/lead-assignment/settings', input)).data,
  );
}

export function useTestAssignment() {
  return useMutation<AssignmentTestResult, ApiRequestError, AssignmentTestInput>({
    mutationFn: async (input) =>
      (await api.post<ItemEnvelope<AssignmentTestResult>>('/lead-assignment/test', input)).data,
  });
}

/** Switching a rule on or off is one click, so it is its own small write (it carries the rule's version). */
export function useToggleRule() {
  return useWrite(
    async (input: { rule: AssignmentRule; enabled: boolean }) =>
      (
        await api.patch<ItemEnvelope<AssignmentRule>>(`/lead-assignment/rules/${input.rule.id}`, {
          enabled: input.enabled,
          version: input.rule.version,
        })
      ).data,
  );
}
