import { AppShell } from '../../../../components/app-shell';
import { TeamsPage } from '../../../../components/teams-page';
import type { Metadata } from 'next';
import { t } from '../../../../lib/i18n';

export const metadata: Metadata = { title: t('teams.title') };

export default function Page() {
  return (
    <AppShell>
      <TeamsPage />
    </AppShell>
  );
}
