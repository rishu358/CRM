import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind classes, letting later classes win.
 *
 * Without the merge step, a caller passing `px-6` to a component that already
 * sets `px-4` gets both, and which one applies depends on stylesheet order
 * rather than on what they asked for.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
