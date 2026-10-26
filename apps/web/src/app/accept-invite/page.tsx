'use client';

import { Suspense } from 'react';
import { AcceptInvite } from '../../components/accept-invite';
import { AuthShell } from '../../components/auth-shell';
import { t } from '../../lib/i18n';

/**
 * Where an invitation link lands.
 *
 * Signed-out as well as signed-in people reach this page, so it sits outside
 * the app shell, beside the other auth screens. `useSearchParams` needs a
 * Suspense boundary, and the fallback is the same "checking" frame the
 * component shows while it asks the API what this link is for.
 */
export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<AuthShell title={t('invite.loading')}>{null}</AuthShell>}>
      <AcceptInvite />
    </Suspense>
  );
}
