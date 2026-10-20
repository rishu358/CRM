import { AppShell } from '../../../components/app-shell';
import { TeamSettings } from '../../../components/team-settings';
import type { Metadata } from 'next';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('team.title') };

export default function Page() {
  return (
    <AppShell>
      <TeamSettings />
    </AppShell>
  );
}
