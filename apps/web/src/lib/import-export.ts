'use client';

import type { DownloadLink, ExportJob, ImportJob } from '@crm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';

/**
 * Server state for import and export (MVP_SPEC §M8).
 *
 * Two things here are deliberately unlike the rest of the app's data layer:
 *
 * **The file never goes through the API.** `uploadToStore` PUTs it straight to
 * the object store on the presigned URL the API handed out (CLAUDE.md §5.12), and
 * a download is a navigation to a presigned URL. Neither uses `api`, because
 * `api` is the credential-attaching proxy and the store must receive no session
 * (`credentials: 'omit'`).
 *
 * **Jobs are polled while they are moving.** An import or export is background
 * work, so the UI asks again every second or two until the job reaches a state
 * that will not change, and then stops.
 */

export type ImportRecord = ImportJob;
export type ExportRecord = ExportJob;

/** States a job will leave by itself, so it is worth asking again. */
const IMPORT_ACTIVE = new Set<ImportJob['status']>([
  'awaiting_upload',
  'analyzing',
  'staging',
  'processing',
]);
const EXPORT_ACTIVE = new Set<ExportJob['status']>(['queued', 'running']);

export const importKeys = {
  all: ['imports'] as const,
  recent: ['imports', 'recent'] as const,
  job: (id: string) => ['imports', 'job', id] as const,
};

export const exportKeys = {
  job: (id: string) => ['exports', 'job', id] as const,
};

const POLL_MS = 1500;

export function useImportJob(id: string | null) {
  return useQuery<ItemEnvelope<ImportRecord>, ApiRequestError>({
    queryKey: importKeys.job(id ?? ''),
    enabled: id !== null,
    queryFn: () => api.get<ItemEnvelope<ImportRecord>>(`/imports/${id as string}`),
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status !== undefined && IMPORT_ACTIVE.has(status) ? POLL_MS : false;
    },
  });
}

export function useRecentImports(enabled: boolean) {
  return useQuery<ListEnvelope<ImportRecord>, ApiRequestError>({
    queryKey: importKeys.recent,
    enabled,
    queryFn: () => api.get<ListEnvelope<ImportRecord>>('/imports?limit=5'),
  });
}

export interface CreatedImport {
  readonly job: ImportRecord;
  readonly upload: {
    readonly url: string;
    readonly method: 'PUT';
    readonly headers: Record<string, string>;
    readonly expiresAt: string;
  } | null;
}

/**
 * Declare a file, put it in the store, and tell the API it arrived.
 *
 * Three calls, in order. The first returns the presigned URL; the second is the
 * browser talking to the store directly; the third lets the API check the
 * object is there and queue the analysis. The Idempotency-Key makes a retried
 * first call return the job it already made instead of a second one.
 */
export function useUploadImport() {
  const queryClient = useQueryClient();

  return useMutation<
    ImportRecord,
    Error,
    { objectType: 'account' | 'contact' | 'lead'; file: File }
  >({
    mutationFn: async ({ objectType, file }) => {
      const created = await api.post<ItemEnvelope<CreatedImport>>(
        '/imports',
        { objectType, fileName: file.name, sizeBytes: file.size },
        { 'Idempotency-Key': crypto.randomUUID() },
      );
      const { job, upload } = created.data;
      if (upload === null) throw new Error('The import has no upload to make');

      await uploadToStore(upload, file);

      const confirmed = await api.post<ItemEnvelope<ImportRecord>>(`/imports/${job.id}/uploaded`);
      return confirmed.data;
    },
    onSuccess: (job) => {
      queryClient.setQueryData(importKeys.job(job.id), { data: job });
      void queryClient.invalidateQueries({ queryKey: importKeys.recent });
    },
  });
}

/**
 * PUT the file to the object store.
 *
 * `credentials: 'omit'` and no referrer: the store is another origin and must
 * never receive this app's session cookie. Only the headers the API signed are
 * sent. `Content-Length` is not among them because the browser sets it from the
 * body, which is also what makes a mismatch with the signature impossible to
 * forge from here.
 */
async function uploadToStore(
  upload: { url: string; headers: Record<string, string> },
  file: File,
): Promise<void> {
  const response = await globalThis.fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    body: file,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`The upload was refused (${response.status})`);
}

export interface StartImportInput {
  readonly id: string;
  readonly mapping: { column: number; field: string }[];
  readonly duplicateMode: 'skip' | 'update' | 'create';
  readonly matchField: string | null;
}

export function useStartImport() {
  const queryClient = useQueryClient();

  return useMutation<ImportRecord, ApiRequestError, StartImportInput>({
    mutationFn: async ({ id, ...body }) => {
      const result = await api.post<ItemEnvelope<ImportRecord>>(`/imports/${id}/start`, {
        mapping: body.mapping,
        duplicateMode: body.duplicateMode,
        ...(body.duplicateMode === 'create' || body.matchField === null
          ? {}
          : { matchField: body.matchField }),
      });
      return result.data;
    },
    onSuccess: (job) => {
      queryClient.setQueryData(importKeys.job(job.id), { data: job });
      void queryClient.invalidateQueries({ queryKey: importKeys.recent });
    },
  });
}

/** Hand the browser a short-lived URL. The file comes from the store, not from us. */
export function downloadFrom(link: DownloadLink): void {
  const anchor = document.createElement('a');
  anchor.href = link.url;
  // The store sends `Content-Disposition: attachment`, so this saves rather than navigates.
  anchor.rel = 'noreferrer noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function useImportErrorFile() {
  return useMutation<DownloadLink, ApiRequestError, string>({
    mutationFn: async (id) =>
      (await api.post<ItemEnvelope<DownloadLink>>(`/imports/${id}/error-file`)).data,
    onSuccess: downloadFrom,
  });
}

export interface ExportRequest {
  readonly objectType: 'account' | 'contact' | 'lead' | 'deal';
  readonly format: 'csv' | 'xlsx';
  readonly filter?: readonly string[] | undefined;
  readonly sort?: string | undefined;
  readonly q?: string | undefined;
}

export function useCreateExport() {
  return useMutation<ExportRecord, ApiRequestError, ExportRequest>({
    mutationFn: async (request) => {
      const body = {
        objectType: request.objectType,
        format: request.format,
        ...(request.filter === undefined || request.filter.length === 0
          ? {}
          : { filter: [...request.filter] }),
        ...(request.sort === undefined ? {} : { sort: request.sort }),
        ...(request.q === undefined || request.q === '' ? {} : { q: request.q }),
      };
      const result = await api.post<ItemEnvelope<ExportRecord>>('/exports', body, {
        'Idempotency-Key': crypto.randomUUID(),
      });
      return result.data;
    },
  });
}

export function useExportJob(id: string | null) {
  return useQuery<ItemEnvelope<ExportRecord>, ApiRequestError>({
    queryKey: exportKeys.job(id ?? ''),
    enabled: id !== null,
    queryFn: () => api.get<ItemEnvelope<ExportRecord>>(`/exports/${id as string}`),
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status !== undefined && EXPORT_ACTIVE.has(status) ? POLL_MS : false;
    },
  });
}

export function useExportDownload() {
  return useMutation<DownloadLink, ApiRequestError, string>({
    mutationFn: async (id) =>
      (await api.post<ItemEnvelope<DownloadLink>>(`/exports/${id}/download`)).data,
    onSuccess: downloadFrom,
  });
}
