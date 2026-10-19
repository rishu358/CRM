'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError } from './api-client';

/**
 * Server state for the audit viewer, the Recycle Bin and data rights
 * (MVP_SPEC M4, M11, CLAUDE.md §9).
 *
 * All fetching lives here rather than in the components, so caching and
 * invalidation are decided once. Everything goes through `/api/proxy`, which
 * attaches the session cookie server-side.
 *
 * Nothing here decides who may see what. The API refuses what the caller may
 * not do, and these hooks surface the refusal as a 403 the screen reports — the
 * diffs arrive already filtered by the serializer, so there is no client-side
 * stripping to get wrong or to forget (CLAUDE.md §5.4, §9).
 */

export interface AuditEntryView {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly action: string;
  readonly objectType: string;
  readonly recordId: string | null;
  readonly changes: Record<string, { old?: unknown; new?: unknown }>;
  /** How many diff entries the server withheld from this reader. */
  readonly withheldFields: number;
  readonly ipAddress: string | null;
  readonly requestId: string | null;
}

export interface RecycleBinEntryView {
  readonly objectType: string;
  readonly id: string;
  readonly label: string;
  readonly ownerId: string | null;
  readonly deletedAt: string;
  readonly purgeAfter: string;
  readonly version: number;
}

export interface DataExportJobView {
  readonly id: string;
  readonly kind: 'audit_log' | 'tenant' | 'data_subject';
  readonly status: 'queued' | 'running' | 'completed' | 'failed';
  readonly format: 'json' | 'csv';
  readonly rowCount: number | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface ErasureRequestView {
  readonly id: string;
  readonly subjectObjectType: 'contact' | 'lead';
  readonly subjectRecordId: string;
  readonly status: 'pending' | 'processing' | 'completed' | 'failed';
  readonly reason: string | null;
  readonly recordsErased: number;
  readonly auditRowsRedacted: number;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface Page<T> {
  readonly data: T[];
  readonly meta: { nextCursor: string | null; hasMore: boolean };
}

export interface AuditFilters {
  readonly actorId?: string;
  readonly objectType?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
}

export const governanceKeys = {
  audit: (filters: AuditFilters) => ['audit-logs', filters] as const,
  recycleBin: (objectType: string) => ['recycle-bin', objectType] as const,
  erasures: () => ['erasure-requests'] as const,
  archive: (id: string) => ['data-exports', id] as const,
};

function queryString(filters: Record<string, string | undefined>, extra = ''): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const query = params.toString();
  return `${query.length > 0 ? `?${query}&` : '?'}${extra}`;
}

/** The audit log, paged by keyset (ADR-0012). */
export function useAuditLog(filters: AuditFilters) {
  return useInfiniteQuery<Page<AuditEntryView>, ApiRequestError>({
    queryKey: governanceKeys.audit(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<Page<AuditEntryView>>(
        `/audit-logs${queryString(
          { ...filters, cursor: (pageParam as string | null) ?? undefined },
          'limit=50',
        )}`,
      ),
    getNextPageParam: (last) => (last.meta.hasMore ? last.meta.nextCursor : undefined),
  });
}

/** One object type's deleted records. The Bin is read a tab at a time. */
export function useRecycleBin(objectType: string) {
  return useInfiniteQuery<Page<RecycleBinEntryView>, ApiRequestError>({
    queryKey: governanceKeys.recycleBin(objectType),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<Page<RecycleBinEntryView>>(
        `/recycle-bin${queryString(
          { objectType, cursor: (pageParam as string | null) ?? undefined },
          'limit=50',
        )}`,
      ),
    getNextPageParam: (last) => (last.meta.hasMore ? last.meta.nextCursor : undefined),
  });
}

export function useRestoreRecord(objectType: string) {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiRequestError, RecycleBinEntryView>({
    mutationFn: (entry) =>
      api.post(`/recycle-bin/${entry.objectType}/${entry.id}/restore`, {
        version: entry.version,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: governanceKeys.recycleBin(objectType) });
      // The record is live again, so every list that excluded it is now stale.
      void queryClient.invalidateQueries({ queryKey: [`${objectType}s`] });
    },
  });
}

export function useErasureRequests() {
  return useQuery<Page<ErasureRequestView>, ApiRequestError>({
    queryKey: governanceKeys.erasures(),
    queryFn: () => api.get<Page<ErasureRequestView>>('/erasure-requests?limit=50'),
  });
}

export function useRequestErasure() {
  const queryClient = useQueryClient();
  return useMutation<
    { data: ErasureRequestView },
    ApiRequestError,
    { subjectObjectType: 'contact' | 'lead'; subjectRecordId: string; reason?: string }
  >({
    mutationFn: (input) => api.post<{ data: ErasureRequestView }>('/erasure-requests', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: governanceKeys.erasures() });
    },
  });
}

/**
 * Queue an archive.
 *
 * The file is produced in the background and fetched later through a
 * short-lived presigned URL; nothing is streamed through the API
 * (CLAUDE.md §5.12).
 */
export function useRequestArchive() {
  return useMutation<
    { data: DataExportJobView },
    ApiRequestError,
    {
      kind: 'audit_log' | 'tenant' | 'data_subject';
      format?: 'json' | 'csv';
      filters?: AuditFilters;
      subject?: { objectType: 'contact' | 'lead'; recordId: string };
    }
  >({
    mutationFn: (input) => api.post<{ data: DataExportJobView }>('/data-exports', input),
  });
}

/** Poll an archive until it is ready, then stop. */
export function useArchive(id: string | null) {
  return useQuery<{ data: DataExportJobView }, ApiRequestError>({
    queryKey: governanceKeys.archive(id ?? ''),
    enabled: id !== null,
    queryFn: () => api.get<{ data: DataExportJobView }>(`/data-exports/${id!}`),
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status === 'completed' || status === 'failed' ? false : 2000;
    },
  });
}

export function useArchiveDownload() {
  return useMutation<{ data: { url: string; expiresAt: string } }, ApiRequestError, string>({
    mutationFn: (id) =>
      api.post<{ data: { url: string; expiresAt: string } }>(`/data-exports/${id}/download`, {}),
  });
}
