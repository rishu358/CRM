'use client';

import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  Input,
  PlusIcon,
  Skeleton,
} from '@crm/ui';
import { useState, type FormEvent } from 'react';
import { useDeleteTeam, useMembers, useSaveTeam, useTeams, type Team } from '../lib/access';
import { t, tPlural } from '../lib/i18n';
import { AccessLayout } from './access-layout';

/**
 * Teams (MVP_SPEC M3).
 *
 * A team matters to access because `team` scope is resolved through it: a
 * Manager with `team` scope reaches the records of everybody who shares a team
 * with them. The page says so, and the dialog says it again at the moment it
 * counts — when somebody is being added or taken off.
 */
export function TeamsPage() {
  const teams = useTeams();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);

  const forbidden = teams.error?.status === 403;
  const list = teams.data?.data ?? [];

  return (
    <AccessLayout
      active="teams"
      title={t('teams.title')}
      description={t('teams.description')}
      forbidden={forbidden}
      actions={
        <Button onClick={() => setEditing('new')} data-testid="new-team">
          <PlusIcon aria-hidden="true" className="h-4 w-4" />
          {t('teams.new')}
        </Button>
      }
    >
      {teams.isPending ? (
        <div role="status" aria-label={t('teams.loading')} className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : teams.isError ? (
        <ErrorState
          title={t('teams.error.title')}
          description={t('teams.error.description')}
          action={
            <Button variant="outline" size="sm" onClick={() => void teams.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          title={t('teams.empty.title')}
          description={t('teams.empty.description')}
          action={<Button onClick={() => setEditing('new')}>{t('teams.new')}</Button>}
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" data-testid="teams-list">
          {list.map((team) => (
            <li key={team.id}>
              <Card data-testid="team-card">
                <CardHeader
                  title={team.name}
                  description={tPlural('teams.memberCount', team.members.length)}
                  actions={
                    <span className="flex gap-1">
                      <Button variant="outline" size="xs" onClick={() => setEditing(team)}>
                        {t('teams.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setDeleting(team)}
                        aria-label={t('teams.deleteNamed', { name: team.name })}
                      >
                        {t('teams.delete')}
                      </Button>
                    </span>
                  }
                />
                <CardBody>
                  {team.members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('teams.noMembers')}</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {team.members.map((member) => (
                        <li
                          key={member.userId}
                          className="flex items-center gap-2 rounded-full bg-secondary py-1 pl-1 pr-3 text-sm"
                        >
                          <Avatar name={member.name} size="sm" />
                          {member.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {editing === null ? null : (
        <TeamDialog team={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {deleting === null ? null : (
        <DeleteTeamDialog team={deleting} onClose={() => setDeleting(null)} />
      )}
    </AccessLayout>
  );
}

function TeamDialog({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const members = useMembers();
  const save = useSaveTeam();
  const [name, setName] = useState(team?.name ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    new Set(team?.members.map((member) => member.userId) ?? []),
  );

  const people = (members.data?.data ?? []).filter(
    (member) => member.status === 'active' || selected.has(member.userId),
  );

  const message =
    save.error === null
      ? null
      : save.error.code === 'CONFLICT'
        ? t('teams.duplicate')
        : t('error.generic');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await save.mutateAsync({
        ...(team === null ? {} : { id: team.id }),
        name: name.trim(),
        userIds: [...selected],
      });
      onClose();
    } catch {
      // `save.error` carries the code.
    }
  };

  const toggle = (userId: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  return (
    <Dialog
      title={team === null ? t('teams.new') : t('teams.editNamed', { name: team.name })}
      description={t('teams.dialog.description')}
      closeLabel={t('common.close')}
      onClose={() => {
        if (!save.isPending) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" data-testid="team-form">
        {message === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {message}
          </p>
        )}
        <Input
          label={t('teams.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
        />

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t('teams.members')}</legend>
          <p className="mb-2 text-xs text-muted-foreground">{t('teams.members.hint')}</p>
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {people.map((member) => (
              <li key={member.userId}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                  <input
                    type="checkbox"
                    checked={selected.has(member.userId)}
                    onChange={() => toggle(member.userId)}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{member.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{member.roleName}</span>
                  </span>
                  {member.status === 'suspended' ? (
                    <Badge tone="warning">{t('people.status.suspended')}</Badge>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
            {t('field.cancel')}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={name.trim() === ''}>
            {t('teams.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function DeleteTeamDialog({ team, onClose }: { team: Team; onClose: () => void }) {
  const remove = useDeleteTeam();
  return (
    <Dialog
      title={t('teams.delete.title', { name: team.name })}
      description={t('teams.delete.description')}
      closeLabel={t('common.close')}
      size="sm"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
    >
      {remove.error === null ? null : (
        <p role="alert" className="mb-2 text-sm font-medium text-destructive">
          {t('error.generic')}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
          {t('field.cancel')}
        </Button>
        <Button
          variant="destructive"
          loading={remove.isPending}
          onClick={() => void remove.mutateAsync(team.id).then(onClose, () => undefined)}
        >
          {t('teams.delete')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
