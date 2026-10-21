import type { Metadata } from 'next';
import { FieldsScreen } from '../../../components/fields-page';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('fields.title') };

/**
 * Custom fields and picklists, for administrators (MVP_SPEC M9).
 */
export default function FieldsPage() {
  return <FieldsScreen />;
}
