import type { Metadata } from 'next';
import { AppShell } from '../../components/app-shell';
import { SetupPage } from '../../components/setup-page';
import { t } from '../../lib/i18n';

export const metadata: Metadata = { title: t('setup.title') };

export default function Page() {
  return (
    <AppShell>
      <SetupPage />
    </AppShell>
  );
}
