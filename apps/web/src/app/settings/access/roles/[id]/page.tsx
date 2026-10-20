import { AppShell } from '../../../../../components/app-shell';
import { RoleEditor } from '../../../../../components/role-editor';
import type { Metadata } from 'next';
import { t } from '../../../../../lib/i18n';

export const metadata: Metadata = { title: t('roleEditor.title') };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <RoleEditor roleId={id} />
    </AppShell>
  );
}
