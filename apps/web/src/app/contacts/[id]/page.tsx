import { ContactDetail } from '../../../components/contact-detail';
import type { Metadata } from 'next';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('contacts.title') };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactDetail id={id} />;
}
