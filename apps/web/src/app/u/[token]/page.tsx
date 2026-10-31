import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { clientAddressHeaders } from '../../../lib/client-address';
import { webEnv } from '../../../lib/env';
import { t } from '../../../lib/i18n';
import { fetchUnsubscribePage } from '../../../lib/unsubscribe-server';

// A link in somebody's email is not for search engines to list, and the page is never kept by a cache. The
// token is in the address, so nothing on this page may send it on in a Referer header.
export const metadata: Metadata = {
  title: t('unsubscribe.pageTitle'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * The page the link at the foot of an email opens (ADR-0076): `/u/<token>`.
 *
 * Reachable with no session (`PUBLIC_PREFIXES`). Opening it only **asks**: mail scanners open every link in a
 * message, so a page that unsubscribed on load would unsubscribe people who never saw it. The button posts to
 * `/u/<token>/confirm`, a plain form that works without scripts and reads no cookie. A link that does not work,
 * and an email that is gone, look the same, on purpose.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const incoming = new Headers(await headers());
  const result = await fetchUnsubscribePage({
    apiUrl: webEnv().API_URL,
    token,
    clientAddress: clientAddressHeaders(incoming),
  });

  if (result.kind === 'invalid') {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">{t('unsubscribe.invalid.title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('unsubscribe.invalid.description')}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">
        {t('unsubscribe.ask.title', { company: result.companyName })}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t('unsubscribe.ask.description', { company: result.companyName })}
      </p>
      <form method="post" action={`/u/${encodeURIComponent(token)}/confirm`} className="mt-6">
        <button
          type="submit"
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t('unsubscribe.ask.button')}
        </button>
      </form>
    </main>
  );
}
