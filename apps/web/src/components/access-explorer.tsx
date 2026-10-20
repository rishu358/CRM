'use client';

import type { Reach } from '@crm/contracts';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  Table,
  TableCard,
  Td,
  Th,
  THead,
  Tr,
} from '@crm/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemberReach, useMembers, useRoleReach, useRoles } from '../lib/access';
import { actionLabel, fieldAccessLabel, objectLabel, scopeLabel } from '../lib/access-labels';
import { DEFAULT_PREFERENCES, formatCount } from '../lib/format';
import { t, tPlural } from '../lib/i18n';
import { AccessLayout } from './access-layout';

/**
 * "What can this person reach?" (MVP_SPEC M3, ADR-0033).
 *
 * The other direction from the record dialog: pick a person or a role and see,
 * object by object, what they can do and at what scope, how many records that
 * is, and which fields are hidden from them.
 *
 * Everything on this page is the API's answer, which is `can()` and the field
 * engine run for that person — so "Team" here means exactly what a list
 * endpoint will put in its WHERE clause for them, and a count is the length of
 * the list they would get. The URL carries the choice (`?member=` / `?role=`),
 * so a result can be linked to, and the people and roles tables link here.
 */
export function AccessExplorer() {
  const router = useRouter();
  const params = useSearchParams();
  const memberId = params.get('member');
  const roleId = params.get('role');

  const members = useMembers();
  const roles = useRoles();
  const memberReach = useMemberReach(memberId);
  const roleReach = useRoleReach(memberId === null ? roleId : null);

  const forbidden = members.error?.status === 403 || roles.error?.status === 403;
  const subject = memberId !== null ? memberReach : roleReach;
  const chosen = memberId !== null ? `member:${memberId}` : roleId !== null ? `role:${roleId}` : '';

  const choose = (value: string) => {
    if (value === '') router.replace('/settings/access/explorer');
    else {
      const [kind, id] = value.split(':');
      router.replace(`/settings/access/explorer?${kind === 'member' ? 'member' : 'role'}=${id}`);
    }
  };

  return (
    <AccessLayout
      active="explorer"
      title={t('explorer.title')}
      description={t('explorer.description')}
      forbidden={forbidden}
    >
      <div className="mb-6 max-w-md">
        <Select
          label={t('explorer.choose')}
          value={chosen}
          onChange={(event) => choose(event.target.value)}
          data-testid="explorer-subject"
        >
          <option value="">{t('explorer.choose.placeholder')}</option>
          <optgroup label={t('explorer.people')}>
            {(members.data?.data ?? []).map((member) => (
              <option key={member.userId} value={`member:${member.userId}`}>
                {member.name} · {member.roleName}
              </option>
            ))}
          </optgroup>
          <optgroup label={t('explorer.roles')}>
            {(roles.data?.data ?? []).map((role) => (
              <option key={role.id} value={`role:${role.id}`}>
                {role.name}
              </option>
            ))}
          </optgroup>
        </Select>
      </div>

      {chosen === '' ? (
        <EmptyState
          title={t('explorer.empty.title')}
          description={t('explorer.empty.description')}
        />
      ) : subject.isPending ? (
        <div role="status" aria-label={t('explorer.loading')} className="space-y-3">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : subject.isError ? (
        <ErrorState
          title={t('explorer.error.title')}
          description={
            subject.error.status === 404 ? t('explorer.notFound') : t('explorer.error.description')
          }
        />
      ) : (
        <ReachView reach={subject.data.data} />
      )}
    </AccessLayout>
  );
}

const ACTIONS = ['read', 'create', 'update', 'delete', 'export', 'import'] as const;

function ReachView({ reach }: { reach: Reach }) {
  const records = reach.objects.filter((object) => object.kind === 'record');
  const admin = reach.objects.filter((object) => object.kind === 'administrative');

  return (
    <div className="space-y-6" data-testid="reach">
      <p className="text-sm" data-testid="reach-subject">
        {reach.subject.kind === 'member'
          ? t('explorer.subject.member', {
              name: reach.subject.name,
              role: reach.subject.roleName ?? '',
            })
          : t('explorer.subject.role', { name: reach.subject.name })}
      </p>

      <Card>
        <CardHeader
          title={t('explorer.records.title')}
          description={t('explorer.records.description')}
        />
        <ReachTable objects={records} />
      </Card>

      <Card>
        <CardHeader
          title={t('explorer.fields.title')}
          description={t('explorer.fields.description')}
        />
        <ul className="divide-y divide-border">
          {records.map((object) => {
            const restricted = object.fields.filter((field) => field.access !== 'write');
            return (
              <li
                key={object.objectType}
                className="grid gap-2 px-5 py-3 text-sm md:grid-cols-[10rem_1fr]"
                data-testid="reach-fields"
              >
                <span className="font-medium">{objectLabel(object.objectType)}</span>
                {object.fields.length === 0 ? (
                  <span className="text-muted-foreground">{t('explorer.fields.none')}</span>
                ) : restricted.length === 0 ? (
                  <span className="text-muted-foreground">{t('explorer.fields.all')}</span>
                ) : (
                  <span className="flex flex-wrap gap-1.5">
                    {restricted.map((field) => (
                      <Badge
                        key={field.key}
                        tone={field.access === 'hidden' ? 'destructive' : 'warning'}
                      >
                        {field.label} · {fieldAccessLabel(field.access)}
                        {field.narrowedBy === 'object' ? ` (${t('explorer.fields.byObject')})` : ''}
                      </Badge>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title={t('explorer.admin.title')}
          description={t('explorer.admin.description')}
        />
        <ReachTable objects={admin} />
      </Card>
    </div>
  );
}

function ReachTable({ objects }: { objects: Reach['objects'] }) {
  return (
    <TableCard className="rounded-none border-0 shadow-none">
      <Table>
        <THead>
          <tr>
            <Th>{t('roleEditor.matrix.object')}</Th>
            {ACTIONS.map((action) => (
              <Th key={action}>{actionLabel(action)}</Th>
            ))}
            <Th numeric>{t('explorer.records.reach')}</Th>
          </tr>
        </THead>
        <tbody>
          {objects.map((object) => (
            <Tr key={object.objectType} data-testid="reach-row" data-object={object.objectType}>
              <th scope="row" className="whitespace-nowrap px-4 py-2 text-left text-sm font-medium">
                {objectLabel(object.objectType)}
              </th>
              {ACTIONS.map((action) => {
                const cell = object.actions.find((candidate) => candidate.action === action);
                return (
                  <Td key={action} className="whitespace-nowrap" data-action={action}>
                    {cell === undefined ? (
                      <span
                        className="text-muted-foreground"
                        aria-label={t('roleEditor.matrix.notApplicable')}
                      >
                        —
                      </span>
                    ) : cell.allowed ? (
                      <span
                        title={
                          cell.viaRoleName === null
                            ? undefined
                            : t('explorer.via', { role: cell.viaRoleName })
                        }
                      >
                        <Badge tone={cell.scope === 'all' ? 'success' : 'primary'}>
                          {scopeLabel(cell.scope)}
                        </Badge>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('access.scope.none')}</span>
                    )}
                  </Td>
                );
              })}
              <Td numeric>
                {object.readableRecords === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span title={t('explorer.records.reach')}>
                    {tPlural('explorer.records.count', object.readableRecords, {
                      formatted: formatCount(object.readableRecords, DEFAULT_PREFERENCES),
                    })}
                  </span>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableCard>
  );
}
