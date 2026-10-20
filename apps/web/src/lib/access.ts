'use client';

import type {
  AccessCatalogue,
  EffectPreview,
  Member,
  PermissionApplyInput,
  PermissionPatch,
  Reach,
  ReassignInput,
  ReassignPreview,
  ReassignResult,
  RecordAccess,
  RoleCreateInput,
  RoleDetail,
  RoleSummary,
  Team,
} from '@crm/contracts';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for users, roles, teams, ownership and the access explainer
 * (CLAUDE.md §9, MVP_SPEC M3).
 *
 * Nothing here decides what anybody may do. Every answer — including "may I use
 * this screen at all" — comes from the API, which asked `can()`; the web app
 * only shows it. Hiding a screen from somebody is cosmetic (CLAUDE.md §9): the
 * API refuses the request whatever this file does.
 */

export type {
  AccessCatalogue,
  EffectPreview,
  Member,
  PermissionPatch,
  Reach,
  ReassignPreview,
  ReassignResult,
  RecordAccess,
  RoleDetail,
  RoleSummary,
  Team,
};

export const accessKeys = {
  all: ['access'] as const,
  catalogue: () => ['access', 'catalogue'] as const,
  roles: () => ['access', 'roles'] as const,
  role: (id: string) => ['access', 'roles', id] as const,
  members: () => ['access', 'members'] as const,
  teams: () => ['access', 'teams'] as const,
  record: (objectType: string, id: string) => ['access', 'record', objectType, id] as const,
  memberReach: (id: string) => ['access', 'reach', 'member', id] as const,
  roleReach: (id: string) => ['access', 'reach', 'role', id] as const,
};

/** What changes everywhere when permissions do: everything a person could see. */
function permissionsChanged(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: accessKeys.all });
}

// ---------------------------------------------------------------------------
// The catalogue, and whether this person may use any of it
// ---------------------------------------------------------------------------

export function useCatalogue() {
  return useQuery<ItemEnvelope<AccessCatalogue>, ApiRequestError>({
    queryKey: accessKeys.catalogue(),
    queryFn: () => api.get<ItemEnvelope<AccessCatalogue>>('/access/catalogue'),
    // A 403 is the answer, not a fault: retrying it only delays the page that
    // explains it.
    retry: (count, error) => error.status !== 403 && error.status !== 401 && count < 2,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Whether to show the places only administrators go.
 *
 * Asked of the API (the catalogue is behind `role:read`), never inferred from a
 * role name: a custom "People manager" role is an administrator the moment it
 * is granted the right, and a role called "Admin" is not one if its grants were
 * removed. While the answer is pending this is `false`, so nothing flashes in
 * and out of the navigation.
 */
export function useCanManageAccess(): boolean {
  const catalogue = useCatalogue();
  return catalogue.isSuccess;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export function useRoles() {
  return useQuery<ItemEnvelope<RoleSummary[]>, ApiRequestError>({
    queryKey: accessKeys.roles(),
    queryFn: () => api.get<ItemEnvelope<RoleSummary[]>>('/roles'),
    retry: (count, error) => error.status !== 403 && count < 2,
  });
}

export function useRole(id: string) {
  return useQuery<ItemEnvelope<RoleDetail>, ApiRequestError>({
    queryKey: accessKeys.role(id),
    queryFn: () => api.get<ItemEnvelope<RoleDetail>>(`/roles/${id}`),
    retry: (count, error) => error.status !== 403 && error.status !== 404 && count < 2,
  });
}

export function useCreateRole() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<RoleDetail>, ApiRequestError, RoleCreateInput>({
    mutationFn: (input) => api.post<ItemEnvelope<RoleDetail>>('/roles', input),
    onSuccess: () => permissionsChanged(client),
  });
}

export function useUpdateRole(id: string) {
  const client = useQueryClient();
  return useMutation<
    ItemEnvelope<RoleDetail>,
    ApiRequestError,
    { name?: string; description?: string | null }
  >({
    mutationFn: (input) => api.patch<ItemEnvelope<RoleDetail>>(`/roles/${id}`, input),
    onSuccess: () => permissionsChanged(client),
  });
}

export function useDeleteRole() {
  const client = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) => api.delete<void>(`/roles/${id}`),
    onSuccess: () => permissionsChanged(client),
  });
}

/**
 * The effect of a proposed change, computed by the API from `can()`.
 *
 * Debounced by the caller, and `keepPreviousData` so the panel does not blank
 * between keystrokes of an administrator ticking boxes: it keeps showing the
 * last answer, marked as refreshing, until the next one lands.
 */
export function useRolePreview(roleId: string, patch: PermissionPatch | null, key: string) {
  return useQuery<ItemEnvelope<EffectPreview>, ApiRequestError>({
    queryKey: ['access', 'preview', roleId, key],
    enabled: patch !== null,
    queryFn: () =>
      api.post<ItemEnvelope<EffectPreview>>(`/roles/${roleId}/permissions/preview`, patch),
    placeholderData: keepPreviousData,
    // A preview is a statement about *now*. Never reuse one from a while ago.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useApplyPermissions(roleId: string) {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<RoleDetail>, ApiRequestError, PermissionApplyInput>({
    mutationFn: (input) =>
      api.patch<ItemEnvelope<RoleDetail>>(`/roles/${roleId}/permissions`, input),
    onSuccess: () => permissionsChanged(client),
  });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function useMembers() {
  return useQuery<{ data: Member[]; meta: { hasMore: boolean } }, ApiRequestError>({
    queryKey: accessKeys.members(),
    queryFn: () => api.get<{ data: Member[]; meta: { hasMore: boolean } }>('/members?limit=200'),
    retry: (count, error) => error.status !== 403 && count < 2,
  });
}

export function useUpdateMember() {
  const client = useQueryClient();
  return useMutation<
    ItemEnvelope<Member>,
    ApiRequestError,
    { userId: string; roleId?: string; status?: 'active' | 'suspended' }
  >({
    mutationFn: ({ userId, ...body }) =>
      api.patch<ItemEnvelope<Member>>(`/members/${userId}`, body),
    onSuccess: () => permissionsChanged(client),
  });
}

export function useMemberRolePreview(userId: string, roleId: string | null) {
  return useQuery<ItemEnvelope<EffectPreview>, ApiRequestError>({
    queryKey: ['access', 'preview', 'member', userId, roleId],
    enabled: roleId !== null,
    queryFn: () =>
      api.post<ItemEnvelope<EffectPreview>>(`/members/${userId}/role-preview`, { roleId }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function useTeams() {
  return useQuery<ItemEnvelope<Team[]>, ApiRequestError>({
    queryKey: accessKeys.teams(),
    queryFn: () => api.get<ItemEnvelope<Team[]>>('/teams'),
    retry: (count, error) => error.status !== 403 && count < 2,
  });
}

export function useSaveTeam() {
  const client = useQueryClient();
  return useMutation<
    ItemEnvelope<Team>,
    ApiRequestError,
    { id?: string; name: string; userIds: string[] }
  >({
    mutationFn: async ({ id, name, userIds }) => {
      const saved =
        id === undefined
          ? await api.post<ItemEnvelope<Team>>('/teams', { name })
          : await api.patch<ItemEnvelope<Team>>(`/teams/${id}`, { name });
      return api.patch<ItemEnvelope<Team>>(`/teams/${saved.data.id}/members`, { userIds });
    },
    onSuccess: () => permissionsChanged(client),
  });
}

export function useDeleteTeam() {
  const client = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) => api.delete<void>(`/teams/${id}`),
    onSuccess: () => permissionsChanged(client),
  });
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export function useReassignPreview(input: ReassignInput | null) {
  return useQuery<ItemEnvelope<ReassignPreview>, ApiRequestError>({
    queryKey: ['access', 'reassign-preview', input],
    enabled: input !== null,
    queryFn: () => api.post<ItemEnvelope<ReassignPreview>>('/ownership/preview', input),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useReassign() {
  const client = useQueryClient();
  return useMutation<ItemEnvelope<ReassignResult>, ApiRequestError, ReassignInput>({
    mutationFn: (input) => api.post<ItemEnvelope<ReassignResult>>('/ownership/reassign', input),
    onSuccess: () => {
      // Owners moved: every list, board and record the web app holds is stale.
      void client.invalidateQueries();
    },
  });
}

// ---------------------------------------------------------------------------
// The explainer
// ---------------------------------------------------------------------------

export function useRecordAccess(objectType: string, id: string, enabled = true) {
  return useQuery<ItemEnvelope<RecordAccess>, ApiRequestError>({
    queryKey: accessKeys.record(objectType, id),
    enabled,
    queryFn: () => api.get<ItemEnvelope<RecordAccess>>(`/access/records/${objectType}/${id}`),
    // The answer is about *now*; a dialog opened twice should not show the first
    // opening's.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useMemberReach(userId: string | null) {
  return useQuery<ItemEnvelope<Reach>, ApiRequestError>({
    queryKey: accessKeys.memberReach(userId ?? ''),
    enabled: userId !== null,
    queryFn: () => api.get<ItemEnvelope<Reach>>(`/access/members/${userId}`),
    staleTime: 0,
    retry: false,
  });
}

export function useRoleReach(roleId: string | null) {
  return useQuery<ItemEnvelope<Reach>, ApiRequestError>({
    queryKey: accessKeys.roleReach(roleId ?? ''),
    enabled: roleId !== null,
    queryFn: () => api.get<ItemEnvelope<Reach>>(`/access/roles/${roleId}`),
    staleTime: 0,
    retry: false,
  });
}

// ---------------------------------------------------------------------------

/** A value that follows `value` after it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return settled;
}
