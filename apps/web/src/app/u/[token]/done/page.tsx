import type { Metadata } from 'next';
import { t } from '../../../../lib/i18n';

export const metadata: Metadata = {
  title: t('unsubscribe.pageTitle'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * Where the confirm handler sends a person once it is done (ADR-0076). It says the same thing whoever opens it
 * and checks nothing, so it cannot be used to learn whether a link is real: only the page before it, and the
 * API behind that, know.
 */
export default function UnsubscribeDonePage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">{t('unsubscribe.done.title')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t('unsubscribe.done.description')}</p>
    </main>
  );
}
