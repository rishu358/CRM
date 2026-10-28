import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { PublicLeadForm } from '../../../components/public-lead-form';
import { clientAddressHeaders } from '../../../lib/client-address';
import { webEnv } from '../../../lib/env';
import { t } from '../../../lib/i18n';
import { fetchPublicForm } from '../../../lib/public-form-server';

// A company's form is not for search engines to list, and the page is never kept by a cache.
export const metadata: Metadata = {
  title: t('publicForm.pageTitle'),
  robots: { index: false, follow: false },
};

/**
 * The hosted website lead form (ADR-0065 5.1): `/f/<key>`.
 *
 * Reachable with no session (`PUBLIC_PREFIXES`). It reads the form's public definition from the API
 * (which sends no workspace id, no secret and nothing that is not meant for a visitor) and draws it.
 * A key that does not work and a form that is switched off look the same, on purpose.
 */
export default async function PublicFormPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const incoming = new Headers(await headers());
  const result = await fetchPublicForm({
    apiUrl: webEnv().API_URL,
    key,
    clientAddress: clientAddressHeaders(incoming),
  });

  if (result.kind === 'unavailable') {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">{t('publicForm.unavailable.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('publicForm.unavailable.description')}
        </p>
      </main>
    );
  }

  return <PublicLeadForm formKey={key} form={result.form} />;
}
