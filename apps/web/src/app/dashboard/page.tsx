import type { Metadata } from 'next';
import { DashboardScreen } from '../../components/dashboard-page';
import { t } from '../../lib/i18n';

export const metadata: Metadata = { title: t('dashboard.title') };

/**
 * The home screen for the company: how the pipeline, the month and the team are
 * doing (MVP_SPEC M10). My Day stays the home for one person's own work.
 */
export default function DashboardPage() {
  return <DashboardScreen />;
}
