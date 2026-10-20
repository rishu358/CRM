import { AppShell } from '../../../../components/app-shell';
import { RolesPage } from '../../../../components/roles-page';
import type { Metadata } from 'next';
import { t } from '../../../../lib/i18n';

export const metadata: Metadata = { title: t('roles.title') };

export default function Page() {
  return (
    <AppShell>
      <RolesPage />
    </AppShell>
  );
}
