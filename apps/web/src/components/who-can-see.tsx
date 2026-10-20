'use client';

import type { AccessBasis, RecordAccess } from '@crm/contracts';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogFooter,
  ErrorState,
  LockIcon,
  NoPermissionState,
  Select,
  Skeleton,
  cn,
} from '@crm/ui';
import { useState } from 'react';
import { useCanManageAccess, useRecordAccess } from '../lib/access';
import { fieldAccessLabel, objectLabel, objectSingularLabel } from '../lib/access-labels';
import { t, tPlural } from '../lib/i18n';
import { ReassignDialog } from './reassign-dialog';

type OwnedObject = RecordAccess['objectType'];

/**
 * "Who can see this, and why" — on any record (MVP_SPEC M3, ADR-0033).
 *
 * An administrator ticks boxes in a role editor and finds out who could see
 * what when somebody complains. This is the other half of that: pick a record,
 * and be told — for every person, not as a list of names but with the reason —
 * "Priya, because she owns it", "Rahul, because he shares the North team with
 * the owner", "Anita, because her role reaches every contact". Pick a field and
 * it says who can see the phone number and who cannot.
 *
 * **It only shows up for people who may use it**, but that is cosmetic and the
 * button is the least of it: the API answers 403 to anybody else, and 404 for a
 * record outside their own reach. The probe that decides whether to render the
 * button is the same call, so there is no second opinion about who is an
 * administrator in this file.
 */
export function WhoCanSeeButton({
  objectType,
  recordId,
  subject,
}: {
  objectType: OwnedObject;
  recordId: string;
  /** What to call it in a sentence: "this contact". */
  subject: string;
}) {
  const allowed = useCanManageAccess();
  const [open, setOpen] = useState(false);
  if (!allowed) return null;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="who-can-see">
        <LockIcon aria-hidden="true" className="h-4 w-4" />
        {t('whoCanSee.button')}
      </Button>
      {open ? (
        <WhoCanSeeDialog
          objectType={objectType}
          recordId={recordId}
          subject={subject}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function WhoCanSeeDialog({
  objectType,
  recordId,
  subject,
  onClose,
}: {
  objectType: OwnedObject;
  recordId: string;
  subject: string;
  onClose: () => void;
}) {
  const access = useRecordAccess(objectType, recordId);
  const [field, setField] = useState('');
  const [reassigning, setReassigning] = useState(false);

  const data = access.data?.data;

  return (
    <>
      <Dialog
        title={t('whoCanSee.title', { subject })}
        description={t('whoCanSee.description')}
        closeLabel={t('common.close')}
        size="lg"
        onClose={onClose}
        data-testid="who-can-see-dialog"
      >
        {access.isPending ? (
          <div role="status" aria-label={t('whoCanSee.loading')} className="space-y-3">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : access.isError ? (
          access.error.status === 403 ? (
            <NoPermissionState
              compact
              title={t('whoCanSee.forbidden.title')}
              description={t('whoCanSee.forbidden.description')}
            />
          ) : (
            <ErrorState
              compact
              title={t('whoCanSee.error.title')}
              description={
                access.error.status === 404
                  ? t('whoCanSee.notFound')
                  : t('whoCanSee.error.description')
              }
              action={
                <Button variant="outline" size="sm" onClick={() => void access.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          )
        ) : data === undefined ? null : (
          <Explanation data={data} field={field} onField={setField} objectType={objectType} />
        )}

        <DialogFooter>
          {data === undefined ? null : (
            <Button variant="outline" onClick={() => setReassigning(true)}>
              {t('whoCanSee.changeOwner')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </Dialog>

      {reassigning ? (
        <ReassignDialog
          mode="records"
          objectType={objectType}
          recordIds={[recordId]}
          subject={subject}
          onClose={() => {
            setReassigning(false);
            void access.refetch();
          }}
        />
      ) : null}
    </>
  );
}

function Explanation({
  data,
  field,
  onField,
  objectType,
}: {
  data: RecordAccess;
  field: string;
  onField: (field: string) => void;
  objectType: OwnedObject;
}) {
  const can = data.people.filter((person) => person.allowed);
  const cannot = data.people.filter((person) => !person.allowed);
  const chosen = data.fields.find((candidate) => candidate.key === field);
  const objects = objectLabel(objectType).toLowerCase();
  const object = objectSingularLabel(objectType);

  return (
    <div className="space-y-5" data-testid="who-can-see-body">
      <div aria-live="polite">
        <p className="text-sm font-medium" data-testid="who-can-see-summary">
          {t('whoCanSee.summary', { can: can.length, total: data.people.length })}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {data.owner === null
            ? t('whoCanSee.unowned')
            : data.owner.name === null
              ? t('whoCanSee.ownerGone')
              : t('whoCanSee.ownedBy', { name: data.owner.name })}
        </p>
        {data.truncated ? (
          <p className="mt-1 text-xs text-muted-foreground">{t('whoCanSee.truncated')}</p>
        ) : null}
      </div>

      {data.fields.length > 0 ? (
        <div className="max-w-xs">
          <Select
            label={t('whoCanSee.field')}
            hint={t('whoCanSee.field.hint')}
            value={field}
            onChange={(event) => onField(event.target.value)}
            data-testid="who-can-see-field"
          >
            <option value="">{t('whoCanSee.field.whole')}</option>
            {data.fields.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <section aria-labelledby="who-can-heading">
        <h3 id="who-can-heading" className="mb-2 text-sm font-semibold">
          {tPlural('whoCanSee.can', can.length)}
        </h3>
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="who-can-list"
        >
          {can.map((person) => (
            <PersonRow
              key={person.userId}
              person={person}
              objects={objects}
              object={object}
              fieldKey={chosen?.key ?? null}
              fieldLabel={chosen?.label ?? null}
            />
          ))}
          {can.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">{t('whoCanSee.nobody')}</li>
          ) : null}
        </ul>
      </section>

      {cannot.length > 0 ? (
        <section aria-labelledby="who-cannot-heading">
          <h3 id="who-cannot-heading" className="mb-2 text-sm font-semibold">
            {tPlural('whoCanSee.cannot', cannot.length)}
          </h3>
          <ul
            className="divide-y divide-border rounded-md border border-border bg-muted/30"
            data-testid="who-cannot-list"
          >
            {cannot.map((person) => (
              <PersonRow
                key={person.userId}
                person={person}
                objects={objects}
                object={object}
                fieldKey={null}
                fieldLabel={null}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

type Person = RecordAccess['people'][number];

function PersonRow({
  person,
  objects,
  object,
  fieldKey,
  fieldLabel,
}: {
  person: Person;
  objects: string;
  object: string;
  fieldKey: string | null;
  fieldLabel: string | null;
}) {
  const fieldState =
    fieldKey === null || !person.allowed
      ? null
      : person.hiddenFields.includes(fieldKey)
        ? 'hidden'
        : person.readOnlyFields.includes(fieldKey)
          ? 'read'
          : 'write';

  return (
    <li
      className="flex items-start gap-3 px-4 py-3"
      data-testid="who-can-person"
      data-allowed={person.allowed}
      data-basis={person.basis}
    >
      <Avatar name={person.name} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="font-medium">{person.name}</span>
          <span className="text-xs text-muted-foreground">{person.roleName}</span>
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground" data-testid="who-can-reason">
          {reason(person.basis, {
            role: person.roleName,
            team: person.sharedTeamName,
            objects,
            object,
          })}
        </p>
      </div>
      {fieldState === null || fieldLabel === null ? null : (
        <Badge
          tone={
            fieldState === 'hidden' ? 'destructive' : fieldState === 'read' ? 'warning' : 'success'
          }
          className={cn('shrink-0')}
        >
          <span className="sr-only">{fieldLabel}: </span>
          {fieldState === 'write' ? t('whoCanSee.field.sees') : fieldAccessLabel(fieldState)}
        </Badge>
      )}
    </li>
  );
}

/** The reason, in words, for a code the API sent. */
function reason(
  basis: AccessBasis,
  values: { role: string; team: string | null; objects: string; object: string },
): string {
  switch (basis) {
    case 'owner':
      return t('whoCanSee.reason.owner');
    case 'shared_team':
      return values.team === null
        ? t('whoCanSee.reason.sharedTeam.unnamed')
        : t('whoCanSee.reason.sharedTeam', { team: values.team });
    case 'all_records':
      return t('whoCanSee.reason.all', { role: values.role, object: values.object });
    case 'not_owner':
      return t('whoCanSee.reason.notOwner', { role: values.role, objects: values.objects });
    case 'no_shared_team':
      return t('whoCanSee.reason.noSharedTeam', { role: values.role, objects: values.objects });
    case 'unowned':
      return t('whoCanSee.reason.unowned', { role: values.role, objects: values.objects });
    case 'no_grant':
      return t('whoCanSee.reason.noGrant', { role: values.role, objects: values.objects });
  }
}
