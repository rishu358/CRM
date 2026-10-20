'use client';

import { Button, ColumnsIcon } from '@crm/ui';
import { useEffect, useRef, useState } from 'react';
import { t, type TranslationKey } from '../lib/i18n';

/**
 * Choose which columns a list shows (MVP_SPEC M4).
 *
 * The options are the columns **the API actually returned**, passed in by the
 * caller. A chooser built from a static list would offer a field the signed-in
 * user cannot read, and the existence of that option is itself the leak — the
 * cells would be blank, and the label would still say GSTIN (CLAUDE.md §5.4).
 *
 * The choice is not persisted yet. Saved views own that (MVP_SPEC M4), and
 * writing it to this browser's storage in the meantime would quietly become
 * the thing saved views have to migrate away from.
 */
export function ColumnChooser({
  options,
  selected,
  onChange,
}: {
  options: readonly { key: string; label: TranslationKey }[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Escape closes and a click outside closes: a popover that can only be
  // dismissed by clicking its own button is a trap for keyboard users.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const toggle = (key: string) => {
    const next = selected.includes(key)
      ? selected.filter((candidate) => candidate !== key)
      : [...selected, key];
    // Never zero columns: an empty table looks like a failed request.
    if (next.length === 0) return;
    onChange(next);
  };

  return (
    <div ref={container} className="relative">
      <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ColumnsIcon className="h-4 w-4 cursor-pointer" />
        {t('accounts.columns')}
      </Button>

      {open ? (
        <div
          role="group"
          aria-label={t('accounts.columns.description')}
          className="absolute right-0 z-20 mt-1.5 w-60 animate-pop-in rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
        >
          {options.map((option) => (
            <label
              key={option.key}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors duration-fast hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.key)}
                onChange={() => toggle(option.key)}
                className="h-4 w-4"
              />
              {t(option.label)}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
