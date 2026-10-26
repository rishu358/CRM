'use client';

import type {
  OnboardingStatus,
  SampleDataLoaded,
  SampleDataRemoval,
  TenantProfile,
  TenantProfileUpdateInput,
} from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for company setup (CLAUDE.md §9, MVP_SPEC M2).
 *
 * Nothing here decides who may set a company up. `GET /onboarding` is behind
 * `tenant_settings:read`, so it simply fails with 403 for anybody else, and that
 * answer is what hides the screen and the first-run redirect. Inferring it from
 * a role name would put a second copy of the rule in the browser; hiding it is
 * cosmetic anyway (CLAUDE.md §9), because the API refuses every call regardless.
 */

export type { OnboardingStatus, SampleDataLoaded, SampleDataRemoval, TenantProfile };

export const onboardingKeys = {
  all: ['onboarding'] as const,
  status: () => ['onboarding', 'status'] as const,
  profile: () => ['onboarding', 'profile'] as const,
};

/** How often to look again while the worker is removing sample data. */
const REMOVAL_POLL_MS = 1500;

export function useOnboarding() {
  return useQuery<ItemEnvelope<OnboardingStatus>, ApiRequestError>({
    queryKey: onboardingKeys.status(),
    queryFn: () => api.get<ItemEnvelope<OnboardingStatus>>('/onboarding'),
    // A 403 is the answer ("not an administrator"), not a fault: retrying it only
    // delays the page that explains it.
    retry: (count, error) => error.status !== 403 && error.status !== 401 && count < 2,
    staleTime: 30 * 1000,
    // Every page in the shell asks this, and for most people the answer is a 403 that
    // will not change while the tab is open; re-asking on every focus is noise.
    refetchOnWindowFocus: false,
    // The removal runs in the worker, so the screen has to watch for it to finish.
    // It stops polling the moment the flag clears, so an idle page asks for nothing.
    refetchInterval: (query) =>
      query.state.data?.data.sampleData.removing === true ? REMOVAL_POLL_MS : false,
  });
}

export function useTenantProfile() {
  return useQuery<ItemEnvelope<TenantProfile>, ApiRequestError>({
    queryKey: onboardingKeys.profile(),
    queryFn: () => api.get<ItemEnvelope<TenantProfile>>('/tenant'),
    retry: (count, error) => error.status !== 403 && error.status !== 401 && count < 2,
  });
}

export function useUpdateProfile() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<TenantProfile>, ApiRequestError, TenantProfileUpdateInput>({
    mutationFn: (input) => api.patch<ItemEnvelope<TenantProfile>>('/tenant', input),
    onSuccess: (result) => {
      client.setQueryData(onboardingKeys.profile(), result);
      void client.invalidateQueries({ queryKey: onboardingKeys.status() });
    },
  });
}

export function useCompleteSetup() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<OnboardingStatus>, ApiRequestError, void>({
    mutationFn: () => api.post<ItemEnvelope<OnboardingStatus>>('/onboarding/complete'),
    onSuccess: (result) => client.setQueryData(onboardingKeys.status(), result),
  });
}

/**
 * Sample data adds records everywhere, so every list is stale afterwards.
 * Invalidating by prefix keeps this file ignorant of which lists exist.
 */
function recordsChanged(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries();
}

export function useLoadSampleData() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<SampleDataLoaded>, ApiRequestError, void>({
    mutationFn: () => api.post<ItemEnvelope<SampleDataLoaded>>('/onboarding/sample-data'),
    onSuccess: () => recordsChanged(client),
  });
}

export function useRemoveSampleData() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<SampleDataRemoval>, ApiRequestError, void>({
    mutationFn: () => api.delete<ItemEnvelope<SampleDataRemoval>>('/onboarding/sample-data'),
    // The request only asks; the status endpoint reports `removing` until it is done.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: onboardingKeys.status() });
    },
  });
}
