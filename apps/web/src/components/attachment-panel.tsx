'use client';

import { Button, Card, CardBody, CardHeader, EmptyState, ErrorState, Skeleton } from '@crm/ui';
import { ALLOWED_ATTACHMENT_EXTENSIONS, ATTACHMENT_LIMITS } from '@crm/core';
import { useRef, useState } from 'react';
import {
  attachmentProblem,
  useAttachmentStatus,
  useDeleteAttachment,
  useDownloadAttachment,
  useRecordAttachments,
  useUploadAttachment,
  type AttachmentRecord,
  type AttachmentTargetType,
} from '../lib/attachments';
import { DEFAULT_PREFERENCES, formatDateTime, formatFileSize } from '../lib/format';
import { t } from '../lib/i18n';

/**
 * The files on one record (MVP_SPEC §6.1, ADR-0035).
 *
 * Rendered by every record page, because the panel is about the polymorphic
 * pair and not about any one object (ADR-0005). Which record it hangs from is
 * the only thing that differs.
 *
 * Thin on purpose. Nothing here is a security control: the accepted
 * extensions and the size are checked again by the API, the file goes to the
 * object store rather than through this app, and a download is a short-lived
 * link the API decides to issue. What this component owes the user is the
 * four states — loading, empty with an action, error, and no-permission,
 * which for this panel means "you may not read this record's files" and is a
 * 403 rather than an empty list.
 */
export function AttachmentPanel({
  objectType,
  recordId,
}: {
  objectType: AttachmentTargetType;
  recordId: string;
}) {
  const query = useRecordAttachments(objectType, recordId);
  const upload = useUploadAttachment(objectType, recordId);
  const download = useDownloadAttachment();
  const remove = useDeleteAttachment(objectType, recordId);
  const input = useRef<HTMLInputElement>(null);
  const [refused, setRefused] = useState<string | null>(null);
  // The file the worker is still looking at, or has just refused.
  const [watching, setWatching] = useState<string | null>(null);
  const watched = useAttachmentStatus(watching, objectType, recordId);
  const outcome = watched.data?.data;

  // A caller who may not read this record gets 403 or 404. Showing an empty
  // list instead would say "no files here", which is a different and untrue
  // thing (CLAUDE.md §9).
  if (query.isError && (query.error.status === 403 || query.error.status === 404)) return null;

  const checking =
    watching !== null &&
    (outcome === undefined ||
      outcome.status === 'scanning' ||
      outcome.status === 'awaiting_upload');
  const refusal = outcome?.status === 'rejected' ? outcome : null;

  const attachments = query.data?.data ?? [];
  const accept = ALLOWED_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`).join(',');

  const choose = (file: File | undefined) => {
    if (file === undefined) return;
    const problem = attachmentProblem(file);
    if (problem !== null) {
      setRefused(
        problem === 'size'
          ? t('attachments.refused.size', {
              max: formatFileSize(ATTACHMENT_LIMITS.maxUploadBytes, DEFAULT_PREFERENCES),
            })
          : t('attachments.refused.type', { types: ALLOWED_ATTACHMENT_EXTENSIONS.join(', ') }),
      );
      return;
    }
    setRefused(null);
    upload.mutate(file, {
      onSuccess: (attachment) => {
        setWatching(attachment.id);
      },
    });
  };

  return (
    <Card className="mt-6">
      <CardHeader
        title={t('attachments.title')}
        actions={
          <Button size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
            {upload.isPending ? t('attachments.uploading') : t('attachments.add')}
          </Button>
        }
      />
      <CardBody>
        <input
          ref={input}
          type="file"
          className="sr-only"
          accept={accept}
          aria-label={t('attachments.add')}
          onChange={(event) => {
            choose(event.target.files?.[0]);
            // Clear it, so choosing the same file twice in a row still fires.
            event.target.value = '';
          }}
        />

        {refused !== null ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {refused}
          </p>
        ) : null}
        {checking ? (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            {t('attachments.checking')}
          </p>
        ) : null}
        {refusal !== null ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {t('attachments.rejected', {
              name: refusal.fileName,
              reason: refusal.failureReason ?? '',
            })}
          </p>
        ) : null}
        {upload.isError ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {t('attachments.uploadFailed')}
          </p>
        ) : null}

        {query.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError ? (
          <ErrorState
            title={t('attachments.error.title')}
            description={t('attachments.error.description')}
            action={
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : attachments.length === 0 ? (
          <EmptyState
            title={t('attachments.empty.title')}
            description={t('attachments.empty.description')}
            action={
              <Button size="sm" onClick={() => input.current?.click()}>
                {t('attachments.empty.action')}
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {attachments.map((attachment) => (
              <AttachmentRow
                key={attachment.id}
                attachment={attachment}
                onDownload={() => download.mutate(attachment.id)}
                onRemove={() => remove.mutate(attachment.id)}
                removing={remove.isPending && remove.variables === attachment.id}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function AttachmentRow({
  attachment,
  onDownload,
  onRemove,
  removing,
}: {
  attachment: AttachmentRecord;
  onDownload: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        {/*
         * Rendered as text, never as a link whose href is the file and never
         * as markup: the name is a string the uploader chose. The bytes are
         * only ever reached through the button below, which asks the API for
         * a short-lived link each time (ADR-0035).
         */}
        <p className="truncate font-medium">{attachment.fileName}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t('attachments.meta', {
            size: formatFileSize(attachment.sizeBytes, DEFAULT_PREFERENCES),
            when: formatDateTime(attachment.createdAt, DEFAULT_PREFERENCES),
          })}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onDownload}>
        {t('attachments.download')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={removing}
        aria-label={t('attachments.remove.label', { name: attachment.fileName })}
        onClick={onRemove}
      >
        {t('attachments.remove')}
      </Button>
    </li>
  );
}
