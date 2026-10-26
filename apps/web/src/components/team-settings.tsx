'use client';

import {
  Avatar,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  NoPermissionState,
  PageHeader,
  Select,
  Skeleton,
  TeamIcon,
} from '@crm/ui';
import { useState, type FormEvent } from 'react';
import { FormError, FormNotice } from './auth-shell';
import { DEFAULT_PREFERENCES, formatDate } from '../lib/format';
import { t } from '../lib/i18n';
import {
  useAssignableRoles,
  useInvite,
  usePendingInvitations,
  useRevokeInvitation,
  type InvitationSummaryView,
} from '../lib/invitations';

/**
 * Invite people to the workspace, and manage the invitations that are waiting
 * (MVP_SPEC M2).
 *
 * All four states CLAUDE.md §9 requires are here: skeletons while the list
 * loads, an empty state that offers the next action, an error state, and a
 * no-permission state for somebody whose role does not include inviting.
 *
 * That last one is **cosmetic**. The API refused the request; this screen only
 * explains the refusal. Hiding the form would not stop anybody, which is why
 * the permission is checked by `can()` on the server and merely reported here.
 */
export function TeamSettings() {
  const invitations = usePendingInvitations();
  const roles = useAssignableRoles();
  const invite = useInvite();
  const revoke = useRevokeInvitation();

  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const forbidden = invitations.error?.status === 403 || roles.error?.status === 403;
  const roleOptions = roles.data?.data ?? [];
  // The first role the server offers, until the user picks another. Derived
  // rather than set from an effect, so there is no render where the form shows
  // an empty picker that would submit nothing.
  const selectedRoleId = roleId.length > 0 ? roleId : (roleOptions[0]?.id ?? '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setError(null);

    try {
      await invite.mutateAsync({ email, roleId: selectedRoleId });
      setNotice(t('team.invite.sent', { email }));
      setEmail('');
    } catch {
      // The code is what the API guarantees, not the message (CLAUDE.md §8).
      setError(
        invite.error?.code === 'VALIDATION_FAILED' ? t('error.required') : t('error.generic'),
      );
    }
  };

  const withdraw = async (invitation: InvitationSummaryView) => {
    setNotice(null);
    setError(null);
    try {
      await revoke.mutateAsync(invitation);
      setNotice(t('team.pending.revoked', { email: invitation.email }));
    } catch {
      setError(t('error.generic'));
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader className="mb-0" title={t('team.title')} description={t('team.description')} />

      {forbidden ? (
        <NoPermissionState
          title={t('team.forbidden.title')}
          description={t('team.forbidden.description')}
        />
      ) : (
        <>
          <Card>
            <CardHeader title={t('team.invite.title')} />
            <CardBody>
              <form onSubmit={(event) => void submit(event)} className="space-y-4">
                <FormError message={error} />
                <FormNotice message={notice} />
                <Input
                  label={t('team.invite.email')}
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="off"
                  required
                />
                <Select
                  label={t('team.invite.role')}
                  name="roleId"
                  value={selectedRoleId}
                  onChange={(event) => setRoleId(event.target.value)}
                  disabled={roles.isPending}
                  required
                >
                  {roleOptions.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
                <Button
                  type="submit"
                  loading={invite.isPending}
                  disabled={selectedRoleId.length === 0}
                >
                  {t('team.invite.submit')}
                </Button>
              </form>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={t('team.pending.title')} />
            <CardBody>
              <PendingList
                invitations={invitations}
                onRevoke={(invitation) => void withdraw(invitation)}
                revoking={revoke.isPending}
              />
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function PendingList({
  invitations,
  onRevoke,
  revoking,
}: {
  invitations: ReturnType<typeof usePendingInvitations>;
  onRevoke: (invitation: InvitationSummaryView) => void;
  revoking: boolean;
}) {
  if (invitations.isPending) {
    return (
      <div className="space-y-2" role="status" aria-label={t('common.loading')}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (invitations.isError) {
    return (
      <ErrorState
        compact
        title={t('team.error.title')}
        description={t('team.error.description')}
        action={
          <Button variant="outline" onClick={() => void invitations.refetch()}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  const rows = invitations.data.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        icon={<TeamIcon className="h-5 w-5" />}
        title={t('team.empty.title')}
        description={t('team.empty.description')}
      />
    );
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {rows.map((invitation) => (
          <li key={invitation.id} className="flex items-center justify-between gap-4 py-3">
            <Avatar name={invitation.email} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{invitation.email}</p>
              <p className="text-xs text-muted-foreground">
                {invitation.roleName} ·{' '}
                {invitation.invitedByName === null
                  ? t('team.pending.invitedBySomeone')
                  : t('team.pending.invitedBy', { name: invitation.invitedByName })}{' '}
                ·{' '}
                {t('team.pending.expires', {
                  date: formatDate(invitation.expiresAt, DEFAULT_PREFERENCES),
                })}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={revoking}
              onClick={() => onRevoke(invitation)}
            >
              {t('team.pending.revoke')}
            </Button>
          </li>
        ))}
      </ul>
      {invitations.data.meta.hasMore ? (
        <p className="pt-3 text-xs text-muted-foreground">
          {t('team.more', { count: rows.length })}
        </p>
      ) : null}
    </>
  );
}
