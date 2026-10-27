import type { Metadata } from 'next';
import { PipelinesScreen } from '../../../components/pipelines-page';
import { t } from '../../../lib/i18n';

export const metadata: Metadata = { title: t('pipelines.title') };

/**
 * The pipeline and stage editor, for administrators (MVP_SPEC M5, M9).
 */
export default function PipelinesPage() {
  return <PipelinesScreen />;
}
