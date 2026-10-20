'use client';

import { AlertIcon, Card, SuccessIcon } from '@crm/ui';
import type { ReactNode } from 'react';
import { t } from '../lib/i18n';
import { BrandMark } from './brand-mark';

/**
 * The frame every signed-out screen sits in.
 *
 * One component rather than a layout copied into six pages, so the sign-in,
 * sign-up and reset screens cannot drift apart visually — and so the error
 * region behaves identically on all of them.
 *
 * The title is the page's `h1`. It used to be an `h2` inside the card, which
 * left every signed-out screen without a top-level heading for a screen-reader
 * user to land on.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[26rem]">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-xl font-semibold tracking-tight">{t('app.name')}</span>
        </div>
        <Card className="shadow-md">
          <div className="px-6 pt-6">
            <h1 className="text-xl font-semibold">{title}</h1>
            {description === undefined ? null : (
              <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          <div className="px-6 pb-6 pt-5">{children}</div>
        </Card>
        {footer === undefined ? null : (
          <div className="mt-5 text-center text-sm text-muted-foreground">{footer}</div>
        )}
      </div>
    </main>
  );
}

/**
 * A failure message for the whole form.
 *
 * `role="alert"` so it is announced when it appears rather than only when
 * somebody happens to focus the region (CLAUDE.md §9, WCAG AA). The icon makes
 * it more than a red box: colour alone is not a signal (WCAG 1.4.1).
 */
export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
    >
      <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** A confirmation that something worked. */
export function FormNotice({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-success"
    >
      <SuccessIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </p>
  );
}
