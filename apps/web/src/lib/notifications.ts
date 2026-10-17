'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope } from './api-client';

/**
 * Server state for in-app notifications (MVP_SPEC M6).
 *
 * No user id anywhere: the API decides whose notifications these are from
 * the session, so there is nothing here that could ask for somebody else's.
 */
export interface NotificationRecord {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly readAt: string | null;
  readonly createdAt: string;
}

interface NotificationListEnvelope {
  readonly data: NotificationRecord[];
  readonly meta: { nextCursor: string | null; hasMore: boolean; unread: number };
}

export const notificationKeys = {
  all: ['notifications'] as const,
  list: ['notifications', 'list'] as const,
  unread: ['notifications', 'unread'] as const,
};

export function useNotifications(enabled: boolean) {
  return useQuery<NotificationListEnvelope, ApiRequestError>({
    queryKey: notificationKeys.list,
    queryFn: () => api.get<NotificationListEnvelope>('/notifications?limit=20'),
    enabled,
  });
}

/**
 * The badge.
 *
 * Polled rather than pushed: notifications are written by the worker a
 * moment after the event, so there is nothing to subscribe to yet, and one
 * indexed count a minute is cheap. Websockets are a Phase 2 concern.
 */
export function useUnreadCount() {
  return useQuery<ItemEnvelope<{ unread: number }>, ApiRequestError>({
    queryKey: notificationKeys.unread,
    queryFn: () => api.get<ItemEnvelope<{ unread: number }>>('/notifications/unread-count'),
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) => api.post<void>(`/notifications/${id}/read`, {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation<ItemEnvelope<{ updated: number }>, ApiRequestError, void>({
    mutationFn: () => api.post<ItemEnvelope<{ updated: number }>>('/notifications/read-all', {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
