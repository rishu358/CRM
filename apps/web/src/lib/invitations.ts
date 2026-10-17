'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for team invitations (CLAUDE.md §9, MVP_SPEC M2).
 *
 * All fetching lives here rather than in the components, so caching and
 * invalidation are decided once. Everything goes through `/api/proxy`, which
 * attaches the session cookie server-side — with one exception, below.
 *
 * ## The exception
 *
 * Accepting an invitation as a brand-new account produces a session token, and
 * a token the page can read is a token `localStorage` ends up holding. That
 * one call therefore goes to `/api/session`, which turns the token into an
 * httpOnly cookie on this origin and returns a body with no token in it — the
 * same route sign-in uses, for the same reason.
 */
export interface InvitationSummaryView {
  readonly id: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly invitedByName: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface InvitationRoleView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface InvitationPreviewView {
  readonly workspaceName: string;
  readonly email: string;
  readonly roleName: string;
  readonly requiresAccount: boolean;
  readonly signedInAs: string | null;
  readonly canAccept: boolean;
}

interface ListEnvelope {
  readonly data: InvitationSummaryView[];
  readonly meta: { hasMore: boolean };
}

export const invitationKeys = {
  all: ['invitations'] as const,
  pending: () => ['invitations', 'pending'] as const,
  roles: () => ['invitations', 'roles'] as const,
};

export function usePendingInvitations() {
  return useQuery<ListEnvelope, ApiRequestError>({
    queryKey: invitationKeys.pending(),
    queryFn: () => api.get<ListEnvelope>('/invitations?limit=50'),
  });
}

export function useAssignableRoles() {
  return useQuery<ItemEnvelope<InvitationRoleView[]>, ApiRequestError>({
    queryKey: invitationKeys.roles(),
    queryFn: () => api.get<ItemEnvelope<InvitationRoleView[]>>('/invitations/roles'),
    // Roles change about once a year. Refetching them on every focus is pure
    // noise on a screen whose interesting data is the invitation list.
    staleTime: 5 * 60 * 1000,
  });
}

export function useInvite() {
  const queryClient = useQueryClient();
  return useMutation<
    ItemEnvelope<InvitationSummaryView>,
    ApiRequestError,
    { email: string; roleId: string }
  >({
    mutationFn: (input) => api.post<ItemEnvelope<InvitationSummaryView>>('/invitations', input),
    // No optimistic insert: a new invitation retires any earlier one for the
    // same address, so the list after the write is not the list before it plus
    // a row. Refetching is both simpler and correct.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationKeys.pending() }),
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, InvitationSummaryView>({
    mutationFn: (invitation) => api.delete<void>(`/invitations/${invitation.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationKeys.pending() }),
  });
}

/**
 * What an invitation link is for, without consuming it.
 *
 * Sent with whatever session the browser has, because the answer depends on
 * who is signed in: the same link reads as "create your account", "sign in
 * first" or "you are signed in as somebody else" (ADR-0019).
 */
export async function previewInvitation(token: string): Promise<InvitationPreviewView> {
  const response = await api.get<ItemEnvelope<InvitationPreviewView>>(
    `/invitations/accept?token=${encodeURIComponent(token)}`,
  );
  return response.data;
}

/** Accept from an existing, signed-in account. No new session is issued. */
export async function acceptInvitation(token: string): Promise<void> {
  await api.post<ItemEnvelope<unknown>>('/invitations/accept', { token });
}
