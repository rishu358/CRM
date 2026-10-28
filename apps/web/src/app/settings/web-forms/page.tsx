import type { Metadata } from 'next';
import { WebFormsScreen } from '../../../components/web-forms-page';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('webForms.title') };

/**
 * Website lead forms, for administrators (ADR-0065).
 */
export default function WebFormsPage() {
  return <WebFormsScreen />;
}
