'use client';

import type { PermissionPatch } from '@crm/contracts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Select,
  Skeleton,
  Table,
  TableCard,
  Td,
  Th,
  THead,
  Tr,
  cn,
} from '@crm/ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  useApplyPermissions,
  useCatalogue,
  useDebounced,
  useRole,
  useRolePreview,
  type RoleDetail,
} from '../lib/access';
import { actionLabel, objectLabel } from '../lib/access-labels';
import { t, tPlural } from '../lib/i18n';
import { AccessLayout } from './access-layout';
import { BackLink } from './back-link';
import { EffectPreviewPanel, type PreviewStatus } from './effect-preview';

type Scope = 'own' | 'team' | 'all';
type FieldAccess = 'hidden' | 'read' | 'write';

const RECORD_SCOPES: readonly Scope[] = ['own', 'team', 'all'];

function cellKey(objectType: string, action: string): string {
  return `${objectType}.${action}`;
}

/**
 * Edit a role's permissions, and see what the edit would do before saving it
 * (MVP_SPEC M3).
 *
 * The page keeps a **draft**: only the cells the administrator has changed,
 * kept as a patch against what the server holds. Two things follow from that.
 * Saving sends just those cells, so it cannot quietly overwrite a row the
 * screen did not know to show; and the preview is asked about exactly that
 * patch, so what it describes and what is saved are the same object.
 *
 * Saving is held back, deliberately, until the preview on screen is the answer
 * to the draft on screen — see `canSave`. A fast administrator can tick a box
 * and click Save before the new consequence has arrived; that click must not
 * save something whose effect they were never shown.
 */
export function RoleEditor({ roleId }: { roleId: string }) {
  const catalogue = useCatalogue();
  const roleQuery = useRole(roleId);

  const forbidden = catalogue.error?.status === 403 || roleQuery.error?.status === 403;
  const notFound = roleQuery.error?.status === 404;

  return (
    <AccessLayout
      active="roles"
      title={roleQuery.data?.data.name ?? t('roleEditor.title')}
      description={roleQuery.data?.data.description ?? t('roleEditor.description')}
      back={<BackLink href="/settings/access/roles">{t('roleEditor.back')}</BackLink>}
      forbidden={forbidden}
      meta={roleQuery.data?.data.isSystem === true ? <Badge>{t('roles.system')}</Badge> : undefined}
      actions={
        roleQuery.data === undefined ? undefined : (
          <Link
            href={`/settings/access/explorer?role=${roleQuery.data.data.id}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('roleEditor.whatCanTheyReach')}
          </Link>
        )
      }
    >
      {notFound ? (
        <ErrorState
          title={t('roleEditor.notFound.title')}
          description={t('roleEditor.notFound.description')}
        />
      ) : roleQuery.isError || catalogue.isError ? (
        forbidden ? null : (
          <ErrorState
            title={t('roleEditor.error.title')}
            description={t('roleEditor.error.description')}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void roleQuery.refetch();
                  void catalogue.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            }
          />
        )
      ) : roleQuery.data === undefined || catalogue.data === undefined ? (
        <div role="status" aria-label={t('roleEditor.loading')} className="space-y-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : (
        <Editor role={roleQuery.data.data} catalogue={catalogue.data.data} />
      )}
    </AccessLayout>
  );
}

function Editor({
  role,
  catalogue,
}: {
  role: RoleDetail;
  catalogue: NonNullable<ReturnType<typeof useCatalogue>['data']>['data'];
}) {
  const apply = useApplyPermissions(role.id);

  const [grantDraft, setGrantDraft] = useState<ReadonlyMap<string, Scope | null>>(new Map());
  const [fieldDraft, setFieldDraft] = useState<ReadonlyMap<string, FieldAccess | null>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldObject, setFieldObject] = useState<string>(
    catalogue.objects.find((object) => object.kind === 'record')?.objectType ?? '',
  );

  const currentGrants = useMemo(
    () =>
      new Map(role.grants.map((grant) => [cellKey(grant.objectType, grant.action), grant.scope])),
    [role.grants],
  );
  const currentRules = useMemo(
    () =>
      new Map(
        role.fieldRules.map((rule) => [cellKey(rule.objectType, rule.fieldKey), rule.access]),
      ),
    [role.fieldRules],
  );

  // The patch: exactly the cells that differ from what the server holds.
  const patch = useMemo<PermissionPatch | null>(() => {
    const grants = [...grantDraft.entries()].map(([key, scope]) => {
      const [objectType = '', action = ''] = key.split('.');
      return { objectType, action, scope } as PermissionPatch['grants'][number];
    });
    const fieldRules = [...fieldDraft.entries()].map(([key, access]) => {
      const dot = key.indexOf('.');
      return {
        objectType: key.slice(0, dot),
        fieldKey: key.slice(dot + 1),
        access,
      } as PermissionPatch['fieldRules'][number];
    });
    return grants.length + fieldRules.length === 0 ? null : { grants, fieldRules };
  }, [grantDraft, fieldDraft]);

  const patchKey = useMemo(() => JSON.stringify(patch), [patch]);
  const settledKey = useDebounced(patchKey);
  const settledPatch = useMemo(
    () => (settledKey === 'null' ? null : (JSON.parse(settledKey) as PermissionPatch)),
    [settledKey],
  );

  const preview = useRolePreview(role.id, settledPatch, settledKey);

  const status: PreviewStatus =
    patch === null
      ? 'idle'
      : preview.isError
        ? 'error'
        : preview.data === undefined
          ? 'loading'
          : settledKey !== patchKey || preview.isFetching || preview.isPlaceholderData
            ? 'stale'
            : 'ready';

  const effect = preview.data?.data;
  const affected = effect?.people.length ?? 0;

  /** Somebody else saved while this page was open: the digest moved under us. */
  const outOfDate = effect !== undefined && effect.digest !== role.digest;

  const canSave =
    status === 'ready' &&
    effect !== undefined &&
    !outOfDate &&
    !effect.removesLastAdministrator &&
    effect.beyondYourAccess.length === 0 &&
    !apply.isPending;

  // Leaving with unsaved edits is the one way this screen loses work.
  useEffect(() => {
    if (patch === null) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [patch]);

  const valueOf = (objectType: string, action: string): Scope | null => {
    const key = cellKey(objectType, action);
    if (grantDraft.has(key)) return grantDraft.get(key) ?? null;
    return currentGrants.get(key) ?? null;
  };

  const setGrant = (objectType: string, action: string, scope: Scope | null) => {
    const key = cellKey(objectType, action);
    const original = currentGrants.get(key) ?? null;
    setNotice(null);
    apply.reset();
    setGrantDraft((previous) => {
      const next = new Map(previous);
      if (scope === original) next.delete(key);
      else next.set(key, scope);
      return next;
    });
  };

  const fieldValueOf = (objectType: string, fieldKey: string): FieldAccess | null => {
    const key = cellKey(objectType, fieldKey);
    if (fieldDraft.has(key)) return fieldDraft.get(key) ?? null;
    return currentRules.get(key) ?? null;
  };

  const setFieldRule = (objectType: string, fieldKey: string, access: FieldAccess | null) => {
    const key = cellKey(objectType, fieldKey);
    const original = currentRules.get(key) ?? null;
    setNotice(null);
    apply.reset();
    setFieldDraft((previous) => {
      const next = new Map(previous);
      if (access === original) next.delete(key);
      else next.set(key, access);
      return next;
    });
  };

  const discard = () => {
    setGrantDraft(new Map());
    setFieldDraft(new Map());
    setNotice(null);
    apply.reset();
  };

  const save = async () => {
    if (patch === null || effect === undefined) return;
    try {
      await apply.mutateAsync({ ...patch, expectedDigest: effect.digest });
      setGrantDraft(new Map());
      setFieldDraft(new Map());
      setNotice(tPlural('roleEditor.saved', affected));
    } catch {
      // The code is what the API guarantees (CLAUDE.md §8); `apply.error` carries it.
    }
  };

  const errorCode = apply.error?.code;
  const recordObjects = catalogue.objects.filter((object) => object.kind === 'record');
  const adminObjects = catalogue.objects.filter((object) => object.kind === 'administrative');
  const fieldObjectEntry = recordObjects.find((object) => object.objectType === fieldObject);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader
            title={t('roleEditor.records.title')}
            description={t('roleEditor.records.description')}
          />
          <PermissionMatrix
            objects={recordObjects}
            valueOf={valueOf}
            changed={(objectType, action) => grantDraft.has(cellKey(objectType, action))}
            onChange={setGrant}
          />
        </Card>

        <Card>
          <CardHeader
            title={t('roleEditor.admin.title')}
            description={t('roleEditor.admin.description')}
          />
          <PermissionMatrix
            objects={adminObjects}
            valueOf={valueOf}
            changed={(objectType, action) => grantDraft.has(cellKey(objectType, action))}
            onChange={setGrant}
          />
        </Card>

        <Card>
          <CardHeader
            title={t('roleEditor.fields.title')}
            description={t('roleEditor.fields.description')}
            actions={
              <div className="w-44">
                <Select
                  label={t('roleEditor.fields.object')}
                  labelHidden
                  value={fieldObject}
                  onChange={(event) => setFieldObject(event.target.value)}
                >
                  {recordObjects.map((object) => (
                    <option key={object.objectType} value={object.objectType}>
                      {objectLabel(object.objectType)}
                    </option>
                  ))}
                </Select>
              </div>
            }
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-border" data-testid="field-rules">
              {(fieldObjectEntry?.fields ?? []).map((field) => {
                const value = fieldValueOf(fieldObject, field.key);
                const changed = fieldDraft.has(cellKey(fieldObject, field.key));
                return (
                  <li
                    key={field.key}
                    data-changed={changed || undefined}
                    className={cn(
                      'flex items-center justify-between gap-4 px-5 py-2.5',
                      changed && 'bg-accent/50',
                    )}
                  >
                    <span className="min-w-0 text-sm">
                      {field.label}
                      {changed ? (
                        <span className="ml-2 text-xs font-medium text-primary">
                          {t('roleEditor.edited')}
                        </span>
                      ) : null}
                    </span>
                    <div className="w-44 shrink-0">
                      <Select
                        label={`${objectLabel(fieldObject)}: ${field.label}`}
                        labelHidden
                        value={value ?? ''}
                        onChange={(event) =>
                          setFieldRule(
                            fieldObject,
                            field.key,
                            event.target.value === '' ? null : (event.target.value as FieldAccess),
                          )
                        }
                      >
                        <option value="">{t('roleEditor.fields.default')}</option>
                        <option value="hidden">{t('access.fieldAccess.hidden')}</option>
                        <option value="read">{t('access.fieldAccess.read')}</option>
                        <option value="write">{t('roleEditor.fields.unrestricted')}</option>
                      </Select>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      </div>

      <div className="xl:sticky xl:top-4" data-testid="role-effect">
        {notice === null ? null : (
          <div
            role="status"
            data-testid="role-saved"
            className="mb-3 rounded-md border border-success/40 bg-success/10 p-3 text-sm font-medium"
          >
            {notice}
          </div>
        )}
        {errorCode === undefined ? null : (
          <div
            role="alert"
            data-testid="role-save-error"
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
          >
            <p className="font-medium">{saveErrorTitle(errorCode)}</p>
            {errorCode === 'VERSION_CONFLICT' ? (
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => {
                  discard();
                  window.location.reload();
                }}
              >
                {t('roleEditor.reload')}
              </Button>
            ) : null}
          </div>
        )}
        {outOfDate ? (
          <div
            role="alert"
            data-testid="role-out-of-date"
            className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            <p className="font-medium">{t('roleEditor.outOfDate')}</p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() => {
                discard();
                window.location.reload();
              }}
            >
              {t('roleEditor.reload')}
            </Button>
          </div>
        ) : null}

        <EffectPreviewPanel
          status={status}
          preview={effect}
          onRetry={() => void preview.refetch()}
          idleMessage={t('roleEditor.effect.idle')}
          noHoldersMessage={t('roleEditor.effect.noHolders')}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={discard} disabled={patch === null}>
                {t('roleEditor.discard')}
              </Button>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={!canSave}
                loading={apply.isPending}
                data-testid="role-save"
              >
                {affected > 0
                  ? tPlural('roleEditor.save.affecting', affected)
                  : t('roleEditor.save')}
              </Button>
            </>
          }
        />
        {patch !== null && status !== 'ready' && status !== 'error' ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            {t('roleEditor.save.waiting')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function saveErrorTitle(code: string): string {
  switch (code) {
    case 'VERSION_CONFLICT':
      return t('roleEditor.error.conflict');
    case 'LAST_ADMINISTRATOR':
      return t('roleEditor.error.lastAdministrator');
    case 'PERMISSION_ESCALATION':
      return t('roleEditor.error.escalation');
    case 'FORBIDDEN':
      return t('roleEditor.error.forbidden');
    default:
      return t('error.generic');
  }
}

function PermissionMatrix({
  objects,
  valueOf,
  changed,
  onChange,
}: {
  objects: NonNullable<ReturnType<typeof useCatalogue>['data']>['data']['objects'];
  valueOf: (objectType: string, action: string) => Scope | null;
  changed: (objectType: string, action: string) => boolean;
  onChange: (objectType: string, action: string, scope: Scope | null) => void;
}) {
  const actions = ['read', 'create', 'update', 'delete', 'export', 'import'] as const;

  return (
    <TableCard className="rounded-none border-0 shadow-none">
      <Table>
        <THead>
          <tr>
            <Th>{t('roleEditor.matrix.object')}</Th>
            {actions.map((action) => (
              <Th key={action}>{actionLabel(action)}</Th>
            ))}
          </tr>
        </THead>
        <tbody>
          {objects.map((object) => (
            <Tr key={object.objectType}>
              <th scope="row" className="whitespace-nowrap px-4 py-2 text-left text-sm font-medium">
                {objectLabel(object.objectType)}
              </th>
              {actions.map((action) => {
                const grantable = object.actions.includes(action);
                const value = valueOf(object.objectType, action);
                const isChanged = changed(object.objectType, action);
                return (
                  <Td key={action} className="px-1 py-1.5">
                    {grantable || value !== null ? (
                      <div className="relative w-[4.75rem]">
                        <Select
                          label={`${objectLabel(object.objectType)}: ${actionLabel(action)}`}
                          labelHidden
                          value={value ?? ''}
                          data-changed={isChanged || undefined}
                          className={cn(
                            'pl-2 pr-6',
                            isChanged && 'border-primary ring-1 ring-primary',
                            value === null && 'text-muted-foreground',
                          )}
                          onChange={(event) =>
                            onChange(
                              object.objectType,
                              action,
                              event.target.value === '' ? null : (event.target.value as Scope),
                            )
                          }
                        >
                          <option value="">{t('roleEditor.scope.none')}</option>
                          {object.kind === 'administrative' ? (
                            <option value="all">{t('roleEditor.allowed')}</option>
                          ) : (
                            RECORD_SCOPES.map((scope) => (
                              <option key={scope} value={scope}>
                                {t(
                                  scope === 'own'
                                    ? 'roleEditor.scope.own'
                                    : scope === 'team'
                                      ? 'roleEditor.scope.team'
                                      : 'roleEditor.scope.all',
                                )}
                              </option>
                            ))
                          )}
                        </Select>
                        {isChanged ? (
                          <span className="sr-only">{t('roleEditor.edited')}</span>
                        ) : null}
                      </div>
                    ) : (
                      <span
                        className="block w-[4.75rem] px-3 text-sm text-muted-foreground"
                        title={t('roleEditor.matrix.notApplicable')}
                        aria-label={t('roleEditor.matrix.notApplicable')}
                      >
                        —
                      </span>
                    )}
                  </Td>
                );
              })}
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableCard>
  );
}
