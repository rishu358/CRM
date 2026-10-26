'use client';

import {
  Badge,
  Button,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  Input,
  PlusIcon,
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
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useCreateRole, useDeleteRole, useRoles, type RoleSummary } from '../lib/access';
import { DEFAULT_PREFERENCES, formatCount } from '../lib/format';
import { t } from '../lib/i18n';
import { AccessLayout } from './access-layout';

/**
 * Roles (MVP_SPEC M3): what exists, who holds each, and the way into the editor.
 *
 * A role is not edited in a dialog from this list. What a role grants is the
 * most consequential setting in the product, so it gets a page of its own with
 * room for the effect of every change — see `RoleEditor`.
 */
export function RolesPage() {
  const roles = useRoles();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RoleSummary | null>(null);

  const forbidden = roles.error?.status === 403;
  const list = roles.data?.data ?? [];

  return (
    <AccessLayout
      active="roles"
      title={t('roles.title')}
      description={t('roles.description')}
      forbidden={forbidden}
      actions={
        <Button onClick={() => setCreating(true)} data-testid="new-role">
          <PlusIcon aria-hidden="true" className="h-4 w-4" />
          {t('roles.new')}
        </Button>
      }
    >
      {roles.isPending ? (
        <TableSkeleton rows={5} columns={4} label={t('roles.loading')} />
      ) : roles.isError ? (
        <ErrorState
          title={t('roles.error.title')}
          description={t('roles.error.description')}
          action={
            <Button variant="outline" size="sm" onClick={() => void roles.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          title={t('roles.empty.title')}
          description={t('roles.empty.description')}
          action={<Button onClick={() => setCreating(true)}>{t('roles.new')}</Button>}
        />
      ) : (
        <TableCard>
          <Table>
            <THead>
              <tr>
                <Th>{t('roles.name')}</Th>
                <Th numeric>{t('roles.members')}</Th>
                <Th numeric>{t('roles.grants')}</Th>
                <Th>
                  <span className="sr-only">{t('roles.actions')}</span>
                </Th>
              </tr>
            </THead>
            <tbody data-testid="roles-list">
              {list.map((role) => (
                <Tr key={role.id} data-testid="role-row">
                  <Td>
                    <Link
                      href={`/settings/access/roles/${role.id}`}
                      className="font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {role.name}
                    </Link>
                    {role.isSystem ? <Badge className="ml-2">{t('roles.system')}</Badge> : null}
                    {role.description === null ? null : (
                      <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
                        {role.description}
                      </p>
                    )}
                  </Td>
                  <Td numeric className="figures">
                    {formatCount(role.memberCount, DEFAULT_PREFERENCES)}
                  </Td>
                  <Td numeric className="figures">
                    {formatCount(role.grantCount, DEFAULT_PREFERENCES)}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <Link
                      href={`/settings/access/roles/${role.id}`}
                      className="mr-3 text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {t('roles.edit')}
                    </Link>
                    {role.isSystem ? null : (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setDeleting(role)}
                        aria-label={t('roles.deleteNamed', { name: role.name })}
                      >
                        {t('roles.delete')}
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableCard>
      )}

      {creating ? <NewRoleDialog roles={list} onClose={() => setCreating(false)} /> : null}
      {deleting === null ? null : (
        <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} />
      )}
    </AccessLayout>
  );
}

function NewRoleDialog({ roles, onClose }: { roles: RoleSummary[]; onClose: () => void }) {
  const router = useRouter();
  const create = useCreateRole();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState('');

  const message =
    create.error === null
      ? null
      : create.error.code === 'CONFLICT'
        ? t('roles.new.duplicate')
        : create.error.code === 'PERMISSION_ESCALATION'
          ? t('roles.new.escalation')
          : create.error.code === 'VALIDATION_FAILED'
            ? t('error.required')
            : t('error.generic');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        ...(copyFrom === '' ? {} : { copyFromRoleId: copyFrom }),
      });
      // Straight to the editor: a role with no grants is not finished.
      router.push(`/settings/access/roles/${created.data.id}`);
    } catch {
      // `create.error` carries the code.
    }
  };

  return (
    <Dialog
      title={t('roles.new')}
      description={t('roles.new.description')}
      closeLabel={t('common.close')}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="space-y-4"
        data-testid="new-role-form"
      >
        {message === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {message}
          </p>
        )}
        <Input
          label={t('roles.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
        />
        <Input
          label={t('roles.descriptionLabel')}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={500}
        />
        <Select
          label={t('roles.copyFrom')}
          hint={t('roles.copyFrom.hint')}
          value={copyFrom}
          onChange={(event) => setCopyFrom(event.target.value)}
        >
          <option value="">{t('roles.copyFrom.none')}</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
            {t('field.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={name.trim() === ''}>
            {t('roles.create')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function DeleteRoleDialog({ role, onClose }: { role: RoleSummary; onClose: () => void }) {
  const remove = useDeleteRole();

  const message =
    remove.error === null
      ? null
      : remove.error.code === 'ROLE_IN_USE'
        ? t('roles.delete.inUse')
        : remove.error.code === 'CONFLICT'
          ? t('roles.delete.used')
          : t('error.generic');

  return (
    <Dialog
      title={t('roles.delete.title', { name: role.name })}
      description={t('roles.delete.description')}
      closeLabel={t('common.close')}
      size="sm"
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
    >
      {message === null ? null : (
        <p role="alert" className="mb-2 text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={remove.isPending}>
          {t('field.cancel')}
        </Button>
        <Button
          variant="destructive"
          loading={remove.isPending}
          onClick={() => void remove.mutateAsync(role.id).then(onClose, () => undefined)}
        >
          {t('roles.delete')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
