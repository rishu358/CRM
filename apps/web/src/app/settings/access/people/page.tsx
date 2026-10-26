import { AppShell } from '../../../../components/app-shell';
import { PeoplePage } from '../../../../components/people-page';
import type { Metadata } from 'next';
import { t } from '../../../../lib/i18n';

export const metadata: Metadata = { title: t('people.title') };

export default function Page() {
  return (
    <AppShell>
      <PeoplePage />
    </AppShell>
  );
}
