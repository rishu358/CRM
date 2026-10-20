'use client';

import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  InviteIcon,
  Select,
  Table,
  TableCard,
  TableSkeleton,
  Td,
  Th,
  THead,
  Tr,
} from '@crm/ui';
import Link from 'next/link';
import { useState } from 'react';
import {
  useMemberRolePreview,
  useMembers,
  useRoles,
  useUpdateMember,
  type Member,
} from '../lib/access';
import { buttonStyles } from '@crm/ui';
import { DEFAULT_PREFERENCES, formatDate } from '../lib/format';
import { t, tPlural } from '../lib/i18n';
import { AccessLayout } from './access-layout';
import { EffectPreviewPanel, type PreviewStatus } from './effect-preview';
import { ReassignDialog } from './reassign-dialog';

/**
 * The people in the workspace (MVP_SPEC M3): their role, their teams, and the
 * things an administrator does to a person — change their role, suspend them,
 * hand their records to somebody else, and see what they can reach.
 *
 * Changing a role is a permission change, so it goes through the same effect
 * preview as editing a role does; a person is never moved to a role without
 * their administrator having been shown what it does to them.
 */
export function PeoplePage() {
  const members = useMembers();
  const roles = useRoles();

  const [changingRole, setChangingRole] = useState<Member | null>(null);
  const [suspending, setSuspending] = useState<Member | null>(null);
  const [reassigning, setReassigning] = useState<Member | null>(null);

  const forbidden = members.error?.status === 403;
  const list = members.data?.data ?? [];

  return (
    <AccessLayout
      active="people"
      title={t('people.title')}
      description={t('people.description')}
      forbidden={forbidden}
      actions={
        <Link href="/settings/team" className={buttonStyles({ variant: 'outline' })}>
          <InviteIcon aria-hidden="true" className="h-4 w-4" />
          {t('people.invite')}
        </Link>
      }
    >
      {members.isPending ? (
        <TableSkeleton rows={6} columns={5} label={t('people.loading')} />
      ) : members.isError ? (
        <ErrorState
          title={t('people.error.title')}
          description={t('people.error.description')}
          action={
            <Button variant="outline" size="sm" onClick={() => void members.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState title={t('people.empty.title')} description={t('people.empty.description')} />
      ) : (
        <TableCard>
          <Table>
            <THead>
              <tr>
                <Th>{t('people.name')}</Th>
                <Th>{t('people.role')}</Th>
                <Th>{t('people.teams')}</Th>
                <Th>{t('people.status')}</Th>
                <Th>
                  <span className="sr-only">{t('people.actions')}</span>
                </Th>
              </tr>
            </THead>
            <tbody data-testid="people-list">
              {list.map((member) => (
                <Tr key={member.userId} data-testid="person-row">
                  <Td>
                    <div className="flex items-center gap-3">
                      <Avatar name={member.name} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {member.name}
                          {member.isYou ? (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              {t('people.you')}
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <div className="w-44">
                      <Select
                        label={t('people.roleOf', { name: member.name })}
                        labelHidden
                        value={member.roleId}
                        disabled={member.status === 'suspended'}
                        onChange={(event) => {
                          if (event.target.value !== member.roleId) {
                            setChangingRole({ ...member, roleId: event.target.value });
                          }
                        }}
                      >
                        {(roles.data?.data ?? []).map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </Td>
                  <Td>
                    {member.teams.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {member.teams.map((team) => (
                          <Badge key={team.id}>{team.name}</Badge>
                        ))}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {member.status === 'active' ? (
                      <Badge tone="success">{t('people.status.active')}</Badge>
                    ) : (
                      <Badge tone="warning">{t('people.status.suspended')}</Badge>
                    )}
                    {member.joinedAt === null ? null : (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('people.joined', {
                          date: formatDate(member.joinedAt, DEFAULT_PREFERENCES),
                        })}
                      </p>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <Link
                      href={`/settings/access/explorer?member=${member.userId}`}
                      className="mr-3 text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t('people.reach')}
                    </Link>
                    <Button variant="ghost" size="xs" onClick={() => setReassigning(member)}>
                      {t('people.reassign')}
                    </Button>
                    {member.isYou ? null : (
                      <Button variant="ghost" size="xs" onClick={() => setSuspending(member)}>
                        {member.status === 'active' ? t('people.suspend') : t('people.restore')}
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableCard>
      )}

      {changingRole === null ? null : (
        <ChangeRoleDialog
          member={changingRole}
          roleName={roles.data?.data.find((role) => role.id === changingRole.roleId)?.name ?? ''}
          onClose={() => setChangingRole(null)}
        />
      )}
      {suspending === null ? null : (
        <SuspendDialog member={suspending} onClose={() => setSuspending(null)} />
      )}
      {reassigning === null ? null : (
        <ReassignDialog
          mode="owner"
          fromOwner={{ userId: reassigning.userId, name: reassigning.name }}
          onClose={() => setReassigning(null)}
        />
      )}
    </AccessLayout>
  );
}

/**
 * Move somebody to another role — after showing what it does to them.
 *
 * `member.roleId` here is the role being **proposed**; the real one is still the
 * one on the server until Save.
 */
function ChangeRoleDialog({
  member,
  roleName,
  onClose,
}: {
  member: Member;
  roleName: string;
  onClose: () => void;
}) {
  const update = useUpdateMember();
  const preview = useMemberRolePreview(member.userId, member.roleId);
  const effect = preview.data?.data;

  const status: PreviewStatus = preview.isError
    ? 'error'
    : preview.data === undefined
      ? 'loading'
      : preview.isFetching
        ? 'stale'
        : 'ready';

  const canSave =
    status === 'ready' &&
    effect !== undefined &&
    !effect.removesLastAdministrator &&
    effect.beyondYourAccess.length === 0;

  const message =
    update.error === null
      ? null
      : update.error.code === 'LAST_ADMINISTRATOR'
        ? t('roleEditor.error.lastAdministrator')
        : update.error.code === 'PERMISSION_ESCALATION'
          ? t('roleEditor.error.escalation')
          : t('error.generic');

  return (
    <Dialog
      title={t('people.changeRole.title', { name: member.name })}
      description={t('people.changeRole.description', { role: roleName })}
      closeLabel={t('common.close')}
      size="lg"
      onClose={() => {
        if (!update.isPending) onClose();
      }}
    >
      {message === null ? null : (
        <p role="alert" className="mb-3 text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <EffectPreviewPanel
        status={status}
        preview={effect}
        onRetry={() => void preview.refetch()}
        idleMessage={t('people.changeRole.idle')}
        heading={t('people.changeRole.effect')}
      />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
          {t('field.cancel')}
        </Button>
        <Button
          loading={update.isPending}
          disabled={!canSave}
          data-testid="confirm-role-change"
          onClick={() =>
            void update
              .mutateAsync({ userId: member.userId, roleId: member.roleId })
              .then(onClose, () => undefined)
          }
        >
          {t('people.changeRole.confirm', { role: roleName })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function SuspendDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const update = useUpdateMember();
  const suspending = member.status === 'active';

  const message =
    update.error === null
      ? null
      : update.error.code === 'LAST_ADMINISTRATOR'
        ? t('roleEditor.error.lastAdministrator')
        : t('error.generic');

  return (
    <Dialog
      title={
        suspending
          ? t('people.suspend.title', { name: member.name })
          : t('people.restore.title', { name: member.name })
      }
      description={suspending ? t('people.suspend.description') : t('people.restore.description')}
      closeLabel={t('common.close')}
      size="sm"
      onClose={() => {
        if (!update.isPending) onClose();
      }}
    >
      {message === null ? null : (
        <p role="alert" className="mb-2 text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
          {t('field.cancel')}
        </Button>
        <Button
          variant={suspending ? 'destructive' : 'primary'}
          loading={update.isPending}
          onClick={() =>
            void update
              .mutateAsync({
                userId: member.userId,
                status: suspending ? 'suspended' : 'active',
              })
              .then(onClose, () => undefined)
          }
        >
          {suspending ? t('people.suspend') : t('people.restore')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

void tPlural;
