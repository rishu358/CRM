'use client';

import type { BusinessObjectType } from '@crm/core';
import type { ViewFilters } from '@crm/contracts';
import { Button, EditIcon, MoveIcon, RecycleBinIcon, TagIcon } from '@crm/ui';
import { useState } from 'react';
import type { BulkTargetChoice } from '../lib/bulk';
import { useFieldDefinitions } from '../lib/fields';
import { t, tPlural } from '../lib/i18n';
import type { Selection } from '../lib/selection';
import { BulkAssignDialog, BulkDeleteDialog, BulkEditDialog, BulkTagDialog } from './bulk-dialogs';

type Action = 'edit' | 'assign' | 'tag' | 'delete';

/** What a dialog was opened on, fixed at that moment: the list under it will change as it works. */
interface OpenDialog {
  readonly action: Action;
  readonly target: BulkTargetChoice;
  readonly subject: string;
}

/**
 * The bar that appears below a list while rows are ticked (MVP_SPEC M4, ADR-0056).
 *
 * It offers the four actions and nothing about who may do them: a person without the grant gets
 * the API's refusal in words. It says plainly what it will act on, because "Delete" over a list is
 * the one button where the count has to be right: the rows ticked **on screen**, or, only when
 * the person asked for it, every record the current search and filters match.
 *
 * Offering "every record this view matches" appears only when it means something: every loaded
 * row is ticked and there are more than were loaded.
 *
 * Two things keep the answer on screen long enough to be read. The dialog is **not** a child of the
 * bar and is kept while the bar is gone: deleting the last ticked rows empties the selection (the
 * bar goes) and may empty the list (the screen that mounted this component may go too, which is why
 * the page mounts it outside the list's own states), and the report of what happened must outlive
 * both. And the dialog keeps the target it was opened on rather than reading the live selection,
 * which shrinks as the rows it just changed leave the list.
 */
export function BulkBar({
  objectType,
  selection,
  filter,
  hasMore,
  stages,
}: {
  objectType: BusinessObjectType;
  selection: Selection;
  /** The list's own search and conditions: what "every record this view matches" is. */
  filter: ViewFilters;
  hasMore: boolean;
  stages?: readonly { id: string; name: string }[] | undefined;
}) {
  const [open, setOpen] = useState<OpenDialog | null>(null);
  const fields = useFieldDefinitions(objectType);

  const openDialog = (action: Action) =>
    setOpen({
      action,
      target: selection.allMatching
        ? { kind: 'filter', filter }
        : { kind: 'ids', ids: selection.ids },
      subject: selection.allMatching
        ? t('bulk.target.all')
        : tPlural('bulk.target.some', selection.count),
    });

  const close = (changed: boolean) => {
    setOpen(null);
    if (changed) selection.clear();
  };

  const dialog =
    open === null
      ? null
      : { objectType, target: open.target, subject: open.subject, onClose: close };

  return (
    <>
      {selection.count === 0 ? null : (
        <div
          role="region"
          aria-label={t('bulk.bar')}
          className="sticky bottom-3 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-md"
          data-testid="bulk-bar"
        >
          <p className="mr-2 text-sm font-medium" aria-live="polite" data-testid="bulk-count">
            {selection.allMatching
              ? t('bulk.selected.all')
              : tPlural('bulk.selected', selection.count)}
          </p>

          {selection.allVisibleSelected && hasMore && !selection.allMatching ? (
            <Button variant="ghost" size="sm" onClick={selection.selectAllMatching}>
              {t('bulk.selectAllMatching')}
            </Button>
          ) : null}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => openDialog('edit')}>
              <EditIcon className="h-4 w-4" />
              {t('bulk.action.edit')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => openDialog('assign')}>
              <MoveIcon className="h-4 w-4" />
              {t('bulk.action.assign')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => openDialog('tag')}>
              <TagIcon className="h-4 w-4" />
              {t('bulk.action.tag')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => openDialog('delete')}>
              <RecycleBinIcon className="h-4 w-4" />
              {t('bulk.action.delete')}
            </Button>
            <Button variant="ghost" size="sm" onClick={selection.clear}>
              {t('bulk.clear')}
            </Button>
          </div>
        </div>
      )}

      {dialog === null || open === null ? null : open.action === 'edit' ? (
        <BulkEditDialog
          {...dialog}
          definitions={fields.data?.data ?? []}
          {...(stages === undefined ? {} : { stages })}
        />
      ) : open.action === 'assign' ? (
        <BulkAssignDialog {...dialog} />
      ) : open.action === 'tag' ? (
        <BulkTagDialog {...dialog} />
      ) : (
        <BulkDeleteDialog {...dialog} />
      )}
    </>
  );
}
