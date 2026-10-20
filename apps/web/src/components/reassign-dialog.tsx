'use client';

import type { ReassignInput } from '@crm/contracts';
import { Button, Dialog, DialogFooter, Select, Skeleton } from '@crm/ui';
import { useMemo, useState } from 'react';
import { useMembers, useReassign, useReassignPreview } from '../lib/access';
import { objectLabel } from '../lib/access-labels';
import { DEFAULT_PREFERENCES, formatCount } from '../lib/format';
import { t, tPlural } from '../lib/i18n';

type Source =
  | {
      mode: 'owner';
      /** Everything this person owns moves. */
      fromOwner: { userId: string; name: string };
    }
  | {
      mode: 'records';
      objectType: 'account' | 'contact' | 'lead' | 'deal' | 'activity';
      recordIds: string[];
      /** What to call it in the sentence: "this contact". */
      subject: string;
    };

/**
 * Hand records to somebody else (MVP_SPEC M3): one record, several, or everything
 * a person owns when they leave.
 *
 * The count on the button is from the API's own dry run, which is the real
 * reassignment rolled back — so the number an administrator confirms is the
 * number that moves, not an estimate beside it.
 *
 * "Everything somebody owns" can be more than one request is willing to move;
 * the dialog keeps going until nothing remains and says how far it got, rather
 * than reporting success for the first batch.
 */
export function ReassignDialog(props: Source & { onClose: () => void }) {
  const { onClose } = props;
  const members = useMembers();
  const [toOwnerId, setToOwnerId] = useState('');
  // What was moved, and for whom: choosing somebody else starts a fresh count
  // without any effect having to notice.
  const [result, setResult] = useState<{ toOwnerId: string; moved: number } | null>(null);
  const done = result !== null && result.toOwnerId === toOwnerId;
  const moved = done ? result.moved : 0;
  const reassign = useReassign();

  const candidates = (members.data?.data ?? []).filter(
    (member) =>
      member.status === 'active' &&
      (props.mode !== 'owner' || member.userId !== props.fromOwner.userId),
  );

  const input = useMemo<ReassignInput | null>(() => {
    if (toOwnerId === '') return null;
    return props.mode === 'owner'
      ? { mode: 'owner', fromOwnerId: props.fromOwner.userId, toOwnerId }
      : { mode: 'records', objectType: props.objectType, recordIds: props.recordIds, toOwnerId };
  }, [props, toOwnerId]);

  const preview = useReassignPreview(done ? null : input);
  const items = preview.data?.data.items ?? [];
  const willMove = items.reduce((sum, item) => sum + item.willMove, 0);

  const message =
    reassign.error === null
      ? preview.error === null
        ? null
        : errorMessage(preview.error.code)
      : errorMessage(reassign.error.code);

  const run = async () => {
    if (input === null) return;
    let total = 0;
    // Bounded by the API per call; loop until it says nothing remains.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await reassign.mutateAsync(input);
      const batch = result.data.moved.reduce((sum, item) => sum + item.count, 0);
      total += batch;
      if (result.data.remaining === 0 || batch === 0) break;
    }
    setResult({ toOwnerId: input.toOwnerId, moved: total });
  };

  return (
    <Dialog
      title={
        props.mode === 'owner'
          ? t('reassign.owner.title', { name: props.fromOwner.name })
          : t('reassign.record.title', { subject: props.subject })
      }
      description={
        props.mode === 'owner' ? t('reassign.owner.description') : t('reassign.record.description')
      }
      closeLabel={t('common.close')}
      onClose={() => {
        if (!reassign.isPending) onClose();
      }}
    >
      <div className="space-y-4" data-testid="reassign-dialog">
        <Select
          label={t('reassign.to')}
          value={toOwnerId}
          onChange={(event) => setToOwnerId(event.target.value)}
          disabled={reassign.isPending || done}
        >
          <option value="">{t('reassign.choose')}</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name} · {member.roleName}
            </option>
          ))}
        </Select>

        {message === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {message}
          </p>
        )}

        {input !== null && !done ? (
          preview.isPending ? (
            <div role="status" aria-label={t('reassign.counting')}>
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <ul
              className="divide-y divide-border rounded-md border border-border text-sm"
              data-testid="reassign-preview"
            >
              {items.map((item) => (
                <li key={item.objectType} className="flex items-center justify-between px-3 py-2">
                  <span>{objectLabel(item.objectType)}</span>
                  <span className="figures">
                    {tPlural('reassign.willMove', item.willMove)}
                    {item.skipped > 0 ? (
                      <span className="ml-2 text-muted-foreground">
                        {tPlural('reassign.skipped', item.skipped)}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
              {items.length === 0 ? (
                <li className="px-3 py-2 text-muted-foreground">{t('reassign.nothing')}</li>
              ) : null}
            </ul>
          )
        ) : null}

        {done ? (
          <p role="status" className="text-sm font-medium" data-testid="reassign-done">
            {tPlural('reassign.done', moved, {
              total: formatCount(moved, DEFAULT_PREFERENCES),
            })}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={reassign.isPending}>
          {done ? t('common.close') : t('field.cancel')}
        </Button>
        {done ? null : (
          <Button
            onClick={() => void run().catch(() => undefined)}
            loading={reassign.isPending}
            disabled={input === null || preview.isPending || willMove === 0}
            data-testid="reassign-confirm"
          >
            {willMove > 0 ? tPlural('reassign.confirm', willMove) : t('reassign.confirm.none')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case 'FORBIDDEN':
      return t('reassign.error.forbidden');
    case 'VALIDATION_FAILED':
      return t('reassign.error.target');
    case 'FIELD_NOT_WRITABLE':
      return t('reassign.error.field');
    default:
      return t('error.generic');
  }
}
