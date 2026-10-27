'use client';

import { Button, EditIcon, Input } from '@crm/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../lib/i18n';

/**
 * Edit in place (UX principle 2: "edit where you see it").
 *
 * Click or press Enter to edit, Escape to abandon, Enter or blur to save. The
 * value updates optimistically, so the change is visible in well under the
 * 100 ms budget; the caller puts the old value back if the API refuses.
 *
 * Rendered as a button rather than a div with a click handler, so it is
 * reachable and operable from the keyboard without any extra wiring.
 */
export function InlineField({
  label,
  value,
  readOnly = false,
  onSave,
  type = 'text',
  trailing,
}: {
  label: string;
  value: string | null | undefined;
  readOnly?: boolean;
  type?: 'text' | 'email' | 'tel' | 'url' | 'number' | 'date';
  onSave: (next: string | null) => void;
  /** Something that belongs beside the value, such as a chat button; hidden while editing. */
  trailing?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // The draft is seeded when editing starts rather than synchronised from the
  // prop in an effect. Mirroring props into state causes a cascading render on
  // every parent update, and it would also overwrite what the user is typing
  // the moment an optimistic update lands.
  const startEditing = () => {
    setDraft(value ?? '');
    setEditing(true);
  };

  // Focusing is a DOM side effect, which is what effects are for.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    const current = value ?? '';
    if (next === current) return;
    // An emptied field clears the value rather than storing an empty string,
    // so "no phone number" is one state in the database, not two.
    onSave(next.length === 0 ? null : next);
  };

  const cancel = () => {
    setDraft(value ?? '');
    setEditing(false);
  };

  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-3 py-1">
      <span className="pt-1.5 text-sm text-muted-foreground">{label}</span>

      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            id={`field-${label}`}
            ref={inputRef}
            label={label}
            labelHidden
            type={type}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') cancel();
            }}
            className="h-8 px-2"
            wrapperClassName="w-full max-w-sm"
          />
          <Button size="sm" variant="ghost" onMouseDown={cancel}>
            {t('field.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            disabled={readOnly}
            onClick={startEditing}
            aria-label={`${t('field.edit')}: ${label}`}
            className="group flex min-h-8 w-full max-w-sm items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-fast hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
          >
            {value === null || value === undefined || value === '' ? (
              <span className="text-muted-foreground">{t('field.empty')}</span>
            ) : (
              <span className="min-w-0 truncate">{value}</span>
            )}
            {/* The "this is editable" cue, quiet until you point at it or tab to it. */}
            {readOnly ? null : (
              <EditIcon
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            )}
          </button>
          {trailing}
        </div>
      )}
    </div>
  );
}
