import { AppShell } from '../../../../components/app-shell';
import { AccessExplorer } from '../../../../components/access-explorer';
import type { Metadata } from 'next';
import { t } from '../../../../lib/i18n';
import { Suspense } from 'react';

export const metadata: Metadata = { title: t('explorer.title') };

export default function Page() {
  return (
    <AppShell>
      {/* `useSearchParams` needs a boundary above it to prerender the shell. */}
      <Suspense>
        <AccessExplorer />
      </Suspense>
    </AppShell>
  );
}
