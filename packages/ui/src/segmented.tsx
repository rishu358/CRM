import type { ReactNode } from 'react';
import { cn } from './cn.js';

/**
 * Two to four mutually exclusive views of the same data (Board / List).
 *
 * A group of toggle buttons, each with `aria-pressed`, rather than a tab list:
 * these do not switch between panels of different content, they re-present the
 * same records, and a button that says whether it is on is the honest widget.
 * The selected option is the one that is raised, not merely the one that is
 * darker, so it reads without relying on colour.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** Names the group for assistive technology. */
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex h-9 items-center rounded-md border border-input bg-secondary p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-full items-center gap-1.5 rounded-[5px] px-3 text-sm transition-colors duration-fast',
              selected
                ? 'bg-card font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
