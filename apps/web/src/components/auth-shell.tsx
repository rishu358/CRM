'use client';

import { Card, CardBody, CardHeader } from '@crm/ui';
import type { ReactNode } from 'react';
import { t } from '../lib/i18n';

/**
 * The frame every signed-out screen sits in.
 *
 * One component rather than a layout copied into six pages, so the sign-in,
 * sign-up and reset screens cannot drift apart visually — and so the error
 * region behaves identically on all of them.
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
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center text-sm font-semibold tracking-tight">{t('app.name')}</div>
        <Card>
          <CardHeader title={title} description={description} />
          <CardBody>{children}</CardBody>
        </Card>
        {footer === undefined ? null : (
          <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>
        )}
      </div>
    </main>
  );
}

/**
 * A failure message for the whole form.
 *
 * `role="alert"` so it is announced when it appears rather than only when
 * somebody happens to focus the region (CLAUDE.md §9, WCAG AA).
 */
export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

/** A confirmation that something worked. */
export function FormNotice({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="status" className="rounded-md border border-border bg-accent px-3 py-2 text-sm">
      {message}
    </p>
  );
}
