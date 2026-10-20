import { AppShell } from '../../../components/app-shell';
import { SecuritySettings } from '../../../components/security-settings';
import type { Metadata } from 'next';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('security.title') };

export default function Page() {
  return (
    <AppShell>
      <SecuritySettings />
    </AppShell>
  );
}
