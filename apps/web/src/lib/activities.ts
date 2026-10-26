'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';

/**
 * Server state for activities and My Day (CLAUDE.md §9).
 *
 * All fetching lives here rather than in components, so caching and
 * invalidation are decided once instead of per screen.
 */
export type LinkTargetType = 'account' | 'contact' | 'lead' | 'deal';

export interface ActivityLinkView {
  readonly objectType: LinkTargetType;
  readonly recordId: string;
  readonly label: string;
}

export interface ActivityRecord {
  readonly id: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly type?: 'task' | 'call' | 'meeting' | 'note';
  readonly subject?: string;
  /**
   * Sanitized HTML (ADR-0024). The API sanitizes on write *and* on read, so
   * what arrives here has been through an allow-list twice; the panel still
   * renders it deliberately rather than by habit, with a comment saying so.
   */
  readonly body?: string | null;
  readonly dueAt?: string | null;
  readonly completedAt?: string | null;
  readonly priority?: 'low' | 'normal' | 'high';
  readonly status?: 'open' | 'completed' | 'cancelled';
  readonly assignedTo?: string | null;
  readonly links?: ActivityLinkView[];
  readonly customFields?: Record<string, unknown>;
}

export interface MyDayData {
  readonly date: string;
  readonly timeZone: string;
  readonly overdue: ActivityRecord[];
  readonly dueToday: ActivityRecord[];
  readonly upcoming: ActivityRecord[];
  readonly recentlyViewed: {
    objectType: LinkTargetType;
    recordId: string;
    label: string;
    viewedAt: string;
  }[];
}

export const activityKeys = {
  all: ['activities'] as const,
  forRecord: (objectType: string, recordId: string) =>
    ['activities', 'record', objectType, recordId] as const,
  myDay: (timeZone: string) => ['activities', 'my-day', timeZone] as const,
};

/**
 * The browser's own time zone.
 *
 * Sent with the My Day request so the day is cut where the person actually
 * is, which may not be what their profile says — somebody travelling should
 * see their day, not the one their settings page remembers. The server
 * validates it and falls back to the profile if it is missing.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** The activities attached to one record, for its record page. */
export function useRecordActivities(objectType: LinkTargetType, recordId: string) {
  return useQuery<ListEnvelope<ActivityRecord>, ApiRequestError>({
    queryKey: activityKeys.forRecord(objectType, recordId),
    queryFn: () => {
      const params = new URLSearchParams({
        objectType,
        recordId,
        limit: '25',
        sort: '-created_at',
      });
      return api.get<ListEnvelope<ActivityRecord>>(`/activities?${params.toString()}`);
    },
  });
}

export function useMyDay(timeZone: string) {
  return useQuery<ItemEnvelope<MyDayData>, ApiRequestError>({
    queryKey: activityKeys.myDay(timeZone),
    queryFn: () =>
      api.get<ItemEnvelope<MyDayData>>(`/my-day?timeZone=${encodeURIComponent(timeZone)}&limit=25`),
  });
}

export function useCreateActivity() {
  const queryClient = useQueryClient();

  return useMutation<ItemEnvelope<ActivityRecord>, ApiRequestError, Record<string, unknown>>({
    mutationFn: (body) => api.post<ItemEnvelope<ActivityRecord>>('/activities', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}

export interface UpdateActivityInput {
  readonly id: string;
  readonly version: number;
  readonly patch: Record<string, unknown>;
}

/**
 * Edit an activity, optimistically.
 *
 * Ticking a task off is the commonest thing anyone does on this screen, and
 * it has to feel instant (UX budget: under 100 ms). The previous value is
 * kept so a rejection — a 409 from a colleague's edit, a 403 from a field
 * permission — puts it back rather than leaving a lie on screen.
 */
export function useUpdateActivity() {
  const queryClient = useQueryClient();

  return useMutation<
    ItemEnvelope<ActivityRecord>,
    ApiRequestError,
    UpdateActivityInput,
    { previous: [readonly unknown[], unknown][] }
  >({
    mutationFn: ({ id, version, patch }) =>
      api.patch<ItemEnvelope<ActivityRecord>>(`/activities/${id}`, { ...patch, version }),

    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: activityKeys.all });
      const previous = queryClient.getQueriesData({ queryKey: activityKeys.all });

      queryClient.setQueriesData({ queryKey: activityKeys.all }, (cached: unknown) =>
        patchCachedActivity(cached, id, patch),
      );

      return { previous };
    },

    // A rejection puts the old value back: a 409 from a colleague's edit or a
    // 403 from a field permission must not leave a tick on screen that the
    // server refused.
    onError: (_error, _input, context) => {
      for (const [key, value] of context?.previous ?? []) {
        queryClient.setQueryData(key, value);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}

/**
 * Apply an optimistic patch wherever this activity is cached.
 *
 * Two shapes hold activities — a record page's list envelope and My Day's
 * three buckets — and a status change has to show up in both, instantly
 * (UX budget: under 100 ms). Written as one walker rather than two updaters
 * so a third screen does not need a third copy.
 */
function patchCachedActivity(cached: unknown, id: string, patch: Record<string, unknown>): unknown {
  if (cached === null || typeof cached !== 'object') return cached;

  const envelope = cached as { data?: unknown };
  const data = envelope.data;

  if (Array.isArray(data)) {
    return { ...envelope, data: data.map((row) => patchRow(row, id, patch)) };
  }

  if (data !== null && typeof data === 'object') {
    const day = data as Record<string, unknown>;
    const next: Record<string, unknown> = { ...day };
    for (const bucket of ['overdue', 'dueToday', 'upcoming']) {
      const rows = day[bucket];
      if (Array.isArray(rows)) next[bucket] = rows.map((row) => patchRow(row, id, patch));
    }
    return { ...envelope, data: next };
  }

  return cached;
}

function patchRow(row: unknown, id: string, patch: Record<string, unknown>): unknown {
  if (row === null || typeof row !== 'object') return row;
  const activity = row as ActivityRecord;
  return activity.id === id ? { ...activity, ...patch } : row;
}

/**
 * "I opened this record."
 *
 * Sent by the record page rather than inferred from the GET, so a read stays
 * a read (see `MyDayService.recordView`). Failures are ignored on purpose:
 * recently-viewed is a convenience, and a person reading a contact should
 * never see an error because the bookkeeping behind it failed.
 */
export function useRecordView() {
  return useMutation<void, ApiRequestError, { objectType: LinkTargetType; recordId: string }>({
    mutationFn: (body) => api.post<void>('/record-views', body),
  });
}
