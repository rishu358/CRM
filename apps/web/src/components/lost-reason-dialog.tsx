'use client';

import { Button, Dialog, DialogFooter, Textarea } from '@crm/ui';
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

  const trimmed = reason.trim();
  const invalid = touched && trimmed.length === 0;

  return (
    <Dialog
      title={t('lost.title')}
      description={t('lost.description', { name: dealName, stage: stageName })}
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (trimmed.length > 0) onConfirm(trimmed);
        }}
      >
        <Textarea
          id="lost-reason"
          ref={inputRef}
          label={t('lost.reason')}
          rows={3}
          maxLength={500}
          value={reason}
          aria-required="true"
          error={invalid ? t('error.required') : undefined}
          onChange={(event) => setReason(event.target.value)}
          onBlur={() => setTouched(true)}
        />

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('field.cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {t('lost.confirm')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
