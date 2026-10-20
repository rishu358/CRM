'use client';

import type {
  Attachment,
  AttachmentCreateResult,
  AttachmentTargetTypeInput,
  DownloadLink,
} from '@crm/contracts';
import { attachmentFileNameProblem, ATTACHMENT_LIMITS } from '@crm/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiRequestError, type ItemEnvelope, type ListEnvelope } from './api-client';
import { downloadFrom } from './import-export';

/**
 * Server state for record attachments (MVP_SPEC §6.1, ADR-0035).
 *
 * The file never goes through the API: `uploadToStore` PUTs it straight to the
 * object store on the presigned URL the API handed out (CLAUDE.md §5.12), and
 * a download is a navigation to a presigned URL. Neither uses `api`, because
 * `api` is the credential-attaching proxy and the store must receive no
 * session cookie.
 */

export type AttachmentRecord = Attachment;
export type AttachmentTargetType = AttachmentTargetTypeInput;

export const attachmentKeys = {
  all: ['attachments'] as const,
  forRecord: (objectType: string, recordId: string) =>
    ['attachments', objectType, recordId] as const,
};

export function useRecordAttachments(objectType: AttachmentTargetType, recordId: string) {
  return useQuery<ListEnvelope<AttachmentRecord>, ApiRequestError>({
    queryKey: attachmentKeys.forRecord(objectType, recordId),
    queryFn: () => {
      const params = new URLSearchParams({ objectType, recordId, limit: '50' });
      return api.get<ListEnvelope<AttachmentRecord>>(`/attachments?${params.toString()}`);
    },
  });
}

/** States an attachment leaves by itself, so it is worth asking again. */
const ATTACHMENT_ACTIVE = new Set<AttachmentRecord['status']>(['awaiting_upload', 'scanning']);

const POLL_MS = 1000;

/**
 * Watch one attachment until the worker has decided what it is.
 *
 * The byte check runs in the worker *after* the API has answered the upload,
 * so a file is neither listed nor refused at that moment. Without this, the
 * list refetches too early, the file appears only after a reload, and a file
 * the worker refuses is never explained to the person who uploaded it.
 */
export function useAttachmentStatus(
  id: string | null,
  objectType: AttachmentTargetType,
  recordId: string,
) {
  const queryClient = useQueryClient();

  return useQuery<ItemEnvelope<AttachmentRecord>, ApiRequestError>({
    queryKey: ['attachments', 'one', id ?? ''],
    enabled: id !== null,
    queryFn: async () => {
      const result = await api.get<ItemEnvelope<AttachmentRecord>>(`/attachments/${id as string}`);
      // The moment the worker passes a file it becomes listable, so the list
      // is refreshed here, once, rather than from a render.
      if (result.data.status === 'ready') {
        await queryClient.invalidateQueries({
          queryKey: attachmentKeys.forRecord(objectType, recordId),
        });
      }
      return result;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.data.status;
      return status === undefined || ATTACHMENT_ACTIVE.has(status) ? POLL_MS : false;
    },
  });
}

/**
 * Why this file cannot be attached, in the browser, before anything is sent.
 *
 * The same two rules the API enforces, from the same module in `@crm/core`,
 * so the message a user sees is the message the server would have given. This
 * is a courtesy and not a control: the API checks again, and the presigned URL
 * binds the size whatever this says.
 */
export function attachmentProblem(file: File): 'file' | 'size' | null {
  if (attachmentFileNameProblem(file.name) !== null) return 'file';
  if (file.size < 1 || file.size > ATTACHMENT_LIMITS.maxUploadBytes) return 'size';
  return null;
}

/**
 * Declare a file, put it in the store, and tell the API it arrived.
 *
 * Three calls, in order. The first returns the presigned URL; the second is
 * the browser talking to the store directly; the third lets the API check the
 * object is there and queue the byte check. The attachment comes back
 * `scanning` or `rejected`, and the list only ever shows `ready` ones.
 */
export function useUploadAttachment(objectType: AttachmentTargetType, recordId: string) {
  const queryClient = useQueryClient();

  return useMutation<AttachmentRecord, ApiRequestError | Error, File>({
    mutationFn: async (file) => {
      const created = await api.post<ItemEnvelope<AttachmentCreateResult>>('/attachments', {
        objectType,
        recordId,
        fileName: file.name,
        sizeBytes: file.size,
      });
      const { attachment, upload } = created.data;

      await uploadToStore(upload, file);

      const confirmed = await api.post<ItemEnvelope<AttachmentRecord>>(
        `/attachments/${attachment.id}/uploaded`,
      );
      return confirmed.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: attachmentKeys.forRecord(objectType, recordId),
      });
    },
  });
}

/**
 * PUT the file to the object store.
 *
 * `credentials: 'omit'` and no referrer: the store is another origin and must
 * never receive this app's session cookie. Only the headers the API signed are
 * sent. `Content-Length` is not among them because the browser sets it from
 * the body, which is also what makes a mismatch with the signature impossible
 * to forge from here.
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

/** Ask for a short-lived link and follow it. The bytes come from the store. */
export function useDownloadAttachment() {
  return useMutation<DownloadLink, ApiRequestError, string>({
    mutationFn: async (id) =>
      (await api.post<ItemEnvelope<DownloadLink>>(`/attachments/${id}/download`)).data,
    onSuccess: downloadFrom,
  });
}

export function useDeleteAttachment(objectType: AttachmentTargetType, recordId: string) {
  const queryClient = useQueryClient();

  return useMutation<void, ApiRequestError, string>({
    mutationFn: async (id) => {
      await api.delete<void>(`/attachments/${id}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: attachmentKeys.forRecord(objectType, recordId),
      });
    },
  });
}
