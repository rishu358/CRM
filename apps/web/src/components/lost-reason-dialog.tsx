'use client';

import { Button } from '@crm/ui';
import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n';

/**
 * Asks why a deal was lost (MVP_SPEC M5: "won/lost with mandatory lost reason").
 *
 * Shown before the move is sent, not after it fails: the API refuses a move to
 * a lost stage without a reason, so the dialog is how a drag onto "Lost" is
 * completed rather than an error the user has to recover from. Cancelling
 * leaves the card where it was — nothing was changed yet.
 */
export function LostReasonDialog({
  dealName,
  stageName,
  pending,
  onConfirm,
  onClose,
}: {
  dealName: string;
  stageName: string;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus moves into the dialog on open and Escape closes it: a modal a
  // keyboard user cannot enter or leave is not usable (CLAUDE.md §9).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const trimmed = reason.trim();
  const invalid = touched && trimmed.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lost-reason-title"
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <h2 id="lost-reason-title" className="mb-1 text-base font-semibold">
          {t('lost.title')}
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('lost.description', { name: dealName, stage: stageName })}
        </p>

        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (trimmed.length > 0) onConfirm(trimmed);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="lost-reason" className="text-sm font-medium">
              {t('lost.reason')}
            </label>
            <textarea
              id="lost-reason"
              ref={inputRef}
              rows={3}
              maxLength={500}
              value={reason}
              aria-required="true"
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? 'lost-reason-error' : undefined}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched(true)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            {invalid ? (
              <p id="lost-reason-error" role="alert" className="text-xs text-destructive">
                {t('error.required')}
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('field.cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {t('lost.confirm')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
