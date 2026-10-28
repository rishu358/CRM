'use client';

import type { MergeableObjectType } from '@crm/core';
import { Button, Card, CardBody, CardHeader, Skeleton } from '@crm/ui';
import Link from 'next/link';
import { useState } from 'react';
import { t, type TranslationKey } from '../lib/i18n';
import { PLURALS, useDuplicates } from '../lib/merge';
import { MergeDialog } from './merge-dialog';

/**
 * "Possible duplicates" on a contact or account page, with a Merge button on each and a way to pick
 * any other record (MVP_SPEC M4, ADR-0064).
 *
 * The list is the API's: the record's own e-mail, phone, domain or name run through the same duplicate
 * rules as the create prompt, limited to what this person may read. A person who may not merge gets a
 * 403 from it and the card is not drawn at all; hiding it is cosmetic, the API refuses the merge itself.
 */
export function DuplicatesCard({
  objectType,
  recordId,
}: {
  objectType: MergeableObjectType;
  recordId: string;
}) {
  const duplicates = useDuplicates(objectType, recordId);
  const [dialog, setDialog] = useState<{ otherId?: string } | null>(null);

  if (duplicates.isError && duplicates.error.status === 403) return null;

  const matches = duplicates.data?.data ?? [];

  return (
    <>
      <Card data-testid="duplicates-card">
        <CardHeader
          title={t('merge.duplicates.title')}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog({})}
              data-testid="merge-with"
            >
              {t('merge.with')}
            </Button>
          }
        />
        <CardBody className="px-5 py-3">
          {duplicates.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : duplicates.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t('merge.duplicates.error')}
            </p>
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="duplicates-none">
              {t('merge.duplicates.none')}
            </p>
          ) : (
            <ul className="divide-y divide-border" aria-label={t('merge.duplicates.title')}>
              {matches.map((match) => (
                <li key={match.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <Link
                      href={`/${PLURALS[objectType]}/${match.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {match.label}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {match.matchedOn
                        .map((reason) => t(`duplicate.reason.${reason}` as TranslationKey))
                        .join(', ')}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialog({ otherId: match.id })}
                    aria-label={t('merge.action.with', { name: match.label })}
                  >
                    {t('merge.action')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {dialog === null ? null : (
        <MergeDialog
          objectType={objectType}
          recordId={recordId}
          initialOtherId={dialog.otherId}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
