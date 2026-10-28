'use client';

import { TAG_COLORS, TAG_NAME_MAX, type TagColor } from '@crm/core';
import {
  Button,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  Input,
  NoPermissionState,
  PageHeader,
  Select,
  TableSkeleton,
  TagChip,
  TagIcon,
  Table,
  TableCard,
  Td,
  Th,
  THead,
  Tr,
  type TagChipColor,
} from '@crm/ui';
import { useState } from 'react';
import { t, tPlural } from '../lib/i18n';
import {
  TAG_COLOR_LABELS,
  totalRecords,
  useDeleteTag,
  useTagUsage,
  useUpdateTag,
  type TagUsage,
} from '../lib/tags';
import { AppShell } from './app-shell';

/**
 * Settings, Tags: rename, recolour and delete the workspace's tags (ADR-0063).
 *
 * Whether the person may be here is the API's answer (a 403 on the usage list, which needs `update` on
 * `tenant_settings`), never a guess from a role name; hiding the nav link is cosmetic. The counts say
 * how many live records of each kind carry a tag, so a delete says what it will touch before it does.
 * A tag is created where it is used, on a record or in a bulk action, so there is no "new tag" button.
 */

function usageText(usage: TagUsage): string {
  const parts = (['contact', 'account', 'lead', 'deal'] as const)
    .filter((kind) => usage.records[kind] > 0)
    .map((kind) => tPlural(`tags.usage.${kind}` as 'tags.usage.contact', usage.records[kind]));
  return parts.length === 0 ? t('tags.usage.none') : parts.join(', ');
}

export function TagsScreen() {
  const query = useTagUsage();
  const [editing, setEditing] = useState<TagUsage | null>(null);
  const [deleting, setDeleting] = useState<TagUsage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const header = <PageHeader title={t('tags.title')} description={t('tags.description')} />;

  if (query.isError) {
    return (
      <AppShell>
        {header}
        {query.error.status === 403 ? (
          <NoPermissionState
            title={t('tags.settings.forbidden.title')}
            description={t('tags.settings.forbidden.description')}
          />
        ) : (
          <ErrorState
            title={t('tags.settings.loadError.title')}
            description={t('tags.settings.loadError.description')}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
      </AppShell>
    );
  }

  if (query.isPending) {
    return (
      <AppShell>
        {header}
        <TableSkeleton rows={5} columns={4} label={t('common.loading')} />
      </AppShell>
    );
  }

  const tags = query.data.data;

  return (
    <AppShell>
      {header}
      <p role="status" aria-live="polite" className="mb-3 min-h-5 text-sm text-success">
        {notice}
      </p>
      {tags.length === 0 ? (
        <EmptyState
          icon={<TagIcon className="h-5 w-5" />}
          title={t('tags.settings.empty.title')}
          description={t('tags.settings.empty.description')}
        />
      ) : (
        <TableCard>
          <Table aria-label={t('tags.settings.table')} data-testid="tags-table">
            <THead>
              <Tr className="hover:bg-transparent">
                <Th>{t('tags.col.name')}</Th>
                <Th>{t('tags.col.used')}</Th>
                <Th>
                  <span className="sr-only">{t('tags.col.actions')}</span>
                </Th>
              </Tr>
            </THead>
            <tbody>
              {tags.map((tag) => (
                <Tr key={tag.id}>
                  <Td>
                    <TagChip name={tag.name} color={tag.color as TagChipColor | null} />
                  </Td>
                  <Td className="text-muted-foreground">{usageText(tag)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setNotice(null);
                          setEditing(tag);
                        }}
                        aria-label={`${t('tags.edit')}: ${tag.name}`}
                      >
                        {t('tags.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setNotice(null);
                          setDeleting(tag);
                        }}
                        aria-label={`${t('tags.delete')}: ${tag.name}`}
                      >
                        {t('tags.delete')}
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableCard>
      )}

      {editing === null ? null : (
        <EditTagDialog
          tag={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice(t('tags.edit.saved'));
          }}
        />
      )}
      {deleting === null ? null : (
        <DeleteTagDialog
          tag={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setNotice(t('tags.delete.deleted'));
          }}
        />
      )}
    </AppShell>
  );
}

function EditTagDialog({
  tag,
  onClose,
  onSaved,
}: {
  tag: TagUsage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const update = useUpdateTag();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<TagColor | ''>(tag.color ?? '');

  const trimmed = name.replace(/\s+/g, ' ').trim();
  const changed = trimmed !== tag.name || (color === '' ? null : color) !== tag.color;
  const error = update.error;
  const errorText =
    error === null
      ? null
      : error.status === 409 && error.code === 'VERSION_CONFLICT'
        ? t('tags.edit.error.conflict')
        : error.status === 409
          ? t('tags.edit.error.taken')
          : (error.error.details[0]?.message ?? t('tags.edit.error.generic'));

  return (
    <Dialog
      title={t('tags.edit.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      data-testid="tag-edit-dialog"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate(
            {
              id: tag.id,
              input: {
                ...(trimmed !== tag.name ? { name: trimmed } : {}),
                ...((color === '' ? null : color) !== tag.color
                  ? { color: color === '' ? null : color }
                  : {}),
                version: tag.version,
              },
            },
            { onSuccess: onSaved },
          );
        }}
      >
        <Input
          label={t('tags.edit.name')}
          value={name}
          maxLength={TAG_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Select
          label={t('tags.edit.color')}
          value={color}
          onChange={(event) => setColor(event.target.value as TagColor | '')}
        >
          <option value="">{t('tags.color.none')}</option>
          {TAG_COLORS.map((value) => (
            <option key={value} value={value}>
              {t(TAG_COLOR_LABELS[value])}
            </option>
          ))}
        </Select>
        <p className="text-sm">
          <TagChip
            name={trimmed.length > 0 ? trimmed : tag.name}
            color={color === '' ? null : color}
          />
        </p>
        {errorText === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errorText}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose}>
            {t('field.cancel')}
          </Button>
          <Button
            type="submit"
            loading={update.isPending}
            disabled={!changed || trimmed.length === 0}
          >
            {t('tags.edit.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function DeleteTagDialog({
  tag,
  onClose,
  onDeleted,
}: {
  tag: TagUsage;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteTag();
  const count = totalRecords(tag);

  return (
    <Dialog
      title={t('tags.delete.title')}
      closeLabel={t('common.close')}
      onClose={onClose}
      size="sm"
      data-testid="tag-delete-dialog"
    >
      <p className="text-sm">
        {count === 0
          ? t('tags.delete.body.none', { name: tag.name })
          : tPlural('tags.delete.body.some', count, { name: tag.name })}
      </p>
      {remove.error === null ? null : (
        <p role="alert" className="mt-3 text-sm font-medium text-destructive">
          {remove.error.status === 409 ? t('tags.edit.error.conflict') : t('tags.delete.error')}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('field.cancel')}
        </Button>
        <Button
          variant="destructive"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate({ id: tag.id, version: tag.version }, { onSuccess: onDeleted })
          }
          data-testid="tag-delete-confirm"
        >
          {t('tags.delete.confirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
