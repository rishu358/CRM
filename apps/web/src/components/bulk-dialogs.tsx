'use client';

import type { BusinessObjectType } from '@crm/core';
import { BULK_MAX_TAGS, BULK_SKIP_REASONS } from '@crm/core';
import {
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
} from '@crm/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { useMembers } from '../lib/access';
import type { ApiRequestError } from '../lib/api-client';
import {
  editValue,
  useBulkAction,
  useEditableFields,
  useTags,
  type BulkActionChoice,
  type BulkTargetChoice,
  type BulkTotals,
} from '../lib/bulk';
import type { FieldDefinitionView } from '../lib/fields';
import { t, tPlural } from '../lib/i18n';

/**
 * The four bulk dialogs (MVP_SPEC M3 and M4, ADR-0056): edit one field, hand over, tag, delete.
 *
 * Each does one thing and then **says what happened**: how many records changed, and for the ones
 * that did not, why, in counts. It never names a record it skipped, because the API does not say
 * more than "not found" about a record the person could not see, and a screen that guessed would
 * be inventing an answer.
 *
 * The buttons never decide who may do what: a person without the grant gets the API's refusal,
 * shown here in words, and nothing changed.
 */

interface DialogProps {
  readonly objectType: BusinessObjectType;
  readonly target: BulkTargetChoice;
  /** How many records, in words, for the sentence: "12 records" or "every record this view matches". */
  readonly subject: string;
  /** Called with whether anything changed, so the screen can drop its selection. */
  readonly onClose: (changed: boolean) => void;
}

/* -------------------------------------------------------------------------- */
/* The frame every dialog shares                                              */
/* -------------------------------------------------------------------------- */

function describeError(error: ApiRequestError): string {
  switch (error.code) {
    case 'FORBIDDEN':
      return t('bulk.error.forbidden');
    case 'RATE_LIMITED':
      return t('bulk.error.rateLimited');
    case 'FIELD_NOT_WRITABLE':
      return t('bulk.error.field');
    default:
      return error.error.details[0]?.message ?? t('error.generic');
  }
}

function Frame({
  title,
  description,
  confirmLabel,
  destructive = false,
  canConfirm,
  onConfirm,
  bulk,
  onClose,
  children,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  bulk: ReturnType<typeof useBulkAction>;
  onClose: (changed: boolean) => void;
  children: ReactNode;
}) {
  const result = bulk.data;
  const done = result !== undefined;

  return (
    <Dialog
      title={title}
      description={description}
      closeLabel={t('common.close')}
      onClose={() => {
        if (!bulk.isPending) onClose(done && result.changed > 0);
      }}
    >
      <div className="space-y-4" data-testid="bulk-dialog">
        {done ? null : children}

        {bulk.isPending && bulk.progress !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {tPlural('bulk.progress', bulk.progress.changed)}
          </p>
        ) : null}

        {bulk.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {describeError(bulk.error)}
          </p>
        )}

        {done ? <Summary totals={result} stoppedEarly={result.stoppedEarly} /> : null}
      </div>

      <DialogFooter>
        {done ? (
          <Button onClick={() => onClose(result.changed > 0)} data-testid="bulk-close">
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onClose(false)} disabled={bulk.isPending}>
              {t('field.cancel')}
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'primary'}
              onClick={onConfirm}
              loading={bulk.isPending}
              disabled={!canConfirm}
              data-testid="bulk-confirm"
            >
              {confirmLabel}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function Summary({ totals, stoppedEarly }: { totals: BulkTotals; stoppedEarly: boolean }) {
  const skipped = BULK_SKIP_REASONS.filter((reason) => totals.skipped[reason] > 0);
  return (
    <div role="status" className="space-y-2 text-sm" data-testid="bulk-result">
      <p className="font-medium">{tPlural('bulk.result.changed', totals.changed)}</p>
      {skipped.length === 0 ? null : (
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {skipped.map((reason) => (
            <li key={reason}>{t(`bulk.skip.${reason}`, { count: totals.skipped[reason] })}</li>
          ))}
        </ul>
      )}
      {stoppedEarly ? <p className="text-muted-foreground">{t('bulk.result.stopped')}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit                                                                       */
/* -------------------------------------------------------------------------- */

export function BulkEditDialog({
  definitions,
  stages,
  ...props
}: DialogProps & {
  definitions: readonly FieldDefinitionView[];
  stages?: readonly { id: string; name: string }[];
}) {
  const bulk = useBulkAction(props.objectType);
  const fields = useEditableFields(props.objectType, definitions, stages);
  const [key, setKey] = useState('');
  const [raw, setRaw] = useState('');
  const [clear, setClear] = useState(false);

  const field = fields.find((candidate) => candidate.key === key);
  const hasValue =
    field !== undefined && (clear || field.input.kind === 'boolean' || raw.trim().length > 0);
  // A number box that holds text would send NaN; the browser keeps it empty, but be exact.
  const valid = field?.input.kind !== 'number' || clear || Number.isFinite(Number(raw));

  const submit = () => {
    if (field === undefined) return;
    const choice: BulkActionChoice = {
      action: 'edit',
      changes: {
        [field.key]: editValue(
          field.input,
          field.input.kind === 'boolean' && raw === '' ? 'false' : raw,
          clear,
        ),
      },
    };
    void bulk.run({ target: props.target, choice }).catch(() => undefined);
  };

  return (
    <Frame
      title={t('bulk.edit.title')}
      description={t('bulk.edit.description', { subject: props.subject })}
      confirmLabel={t('bulk.edit.confirm')}
      canConfirm={hasValue && valid}
      onConfirm={submit}
      bulk={bulk}
      onClose={props.onClose}
    >
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('bulk.edit.noFields')}</p>
      ) : (
        <>
          <Select
            label={t('bulk.edit.field')}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setRaw('');
              setClear(false);
            }}
            disabled={bulk.isPending}
          >
            <option value="">{t('bulk.edit.chooseField')}</option>
            {fields.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </Select>

          {field === undefined ? null : (
            <>
              <ValueInput
                input={field.input}
                label={t('bulk.edit.value')}
                value={raw}
                onChange={setRaw}
                disabled={clear || bulk.isPending}
              />
              <Checkbox
                label={t('bulk.edit.clear')}
                checked={clear}
                onChange={(event) => setClear(event.target.checked)}
                disabled={bulk.isPending}
              />
            </>
          )}
        </>
      )}
    </Frame>
  );
}

function ValueInput({
  input,
  label,
  value,
  onChange,
  disabled,
}: {
  input: ReturnType<typeof useEditableFields>[number]['input'];
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  switch (input.kind) {
    case 'select':
      return (
        <Select
          label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        >
          <option value="">{t('bulk.edit.chooseValue')}</option>
          {input.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      );
    case 'boolean':
      return (
        <Select
          label={label}
          value={value === '' ? 'false' : value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        >
          <option value="true">{t('customFields.yes')}</option>
          <option value="false">{t('customFields.no')}</option>
        </Select>
      );
    case 'number':
      return (
        <Input
          label={label}
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      );
    case 'date':
      return (
        <Input
          label={label}
          type="date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      );
    case 'text':
      return (
        <Input
          label={label}
          value={value}
          maxLength={500}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
        />
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Assign                                                                     */
/* -------------------------------------------------------------------------- */

export function BulkAssignDialog(props: DialogProps) {
  const bulk = useBulkAction(props.objectType);
  const members = useMembers();
  const [ownerId, setOwnerId] = useState('');
  const candidates = (members.data?.data ?? []).filter((member) => member.status === 'active');

  return (
    <Frame
      title={t('bulk.assign.title')}
      description={t('bulk.assign.description', { subject: props.subject })}
      confirmLabel={t('bulk.assign.confirm')}
      canConfirm={ownerId !== ''}
      onConfirm={() =>
        void bulk
          .run({ target: props.target, choice: { action: 'assign', ownerId } })
          .catch(() => undefined)
      }
      bulk={bulk}
      onClose={props.onClose}
    >
      {members.isPending ? (
        <Skeleton className="h-9 w-full" />
      ) : members.isError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t('bulk.assign.noMembers')}
        </p>
      ) : (
        <Select
          label={t('bulk.assign.to')}
          value={ownerId}
          onChange={(event) => setOwnerId(event.target.value)}
          disabled={bulk.isPending}
        >
          <option value="">{t('reassign.choose')}</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name} · {member.roleName}
            </option>
          ))}
        </Select>
      )}
    </Frame>
  );
}

/* -------------------------------------------------------------------------- */
/* Tag                                                                        */
/* -------------------------------------------------------------------------- */

type TagMode = 'tag_add' | 'tag_remove';

export function BulkTagDialog(props: DialogProps) {
  const bulk = useBulkAction(props.objectType);
  const tags = useTags();
  const [mode, setMode] = useState<TagMode>('tag_add');
  const [text, setText] = useState('');

  const names = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const piece of text.split(',')) {
      const name = piece.replace(/\s+/g, ' ').trim();
      if (name.length > 0 && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        result.push(name);
      }
    }
    return result;
  }, [text]);

  const tooMany = names.length > BULK_MAX_TAGS;
  const tooLong = names.some((name) => name.length > 50);
  const listId = 'bulk-tag-suggestions';

  return (
    <Frame
      title={t('bulk.tag.title')}
      description={t('bulk.tag.description', { subject: props.subject })}
      confirmLabel={mode === 'tag_add' ? t('bulk.tag.confirmAdd') : t('bulk.tag.confirmRemove')}
      canConfirm={names.length > 0 && !tooMany && !tooLong}
      onConfirm={() =>
        void bulk
          .run({ target: props.target, choice: { action: mode, tags: names } })
          .catch(() => undefined)
      }
      bulk={bulk}
      onClose={props.onClose}
    >
      <SegmentedControl<TagMode>
        label={t('bulk.tag.mode')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'tag_add', label: t('bulk.tag.add') },
          { value: 'tag_remove', label: t('bulk.tag.remove') },
        ]}
      />
      <Input
        label={t('bulk.tag.names')}
        hint={t('bulk.tag.hint', { max: BULK_MAX_TAGS })}
        error={
          tooMany
            ? t('bulk.tag.tooMany', { max: BULK_MAX_TAGS })
            : tooLong
              ? t('bulk.tag.tooLong')
              : undefined
        }
        value={text}
        list={listId}
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
        disabled={bulk.isPending}
      />
      <datalist id={listId}>
        {(tags.data?.data ?? []).map((tag) => (
          <option key={tag.id} value={tag.name} />
        ))}
      </datalist>
    </Frame>
  );
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

export function BulkDeleteDialog(props: DialogProps) {
  const bulk = useBulkAction(props.objectType);
  return (
    <Frame
      title={t('bulk.delete.title')}
      description={t('bulk.delete.description', { subject: props.subject })}
      confirmLabel={t('bulk.delete.confirm')}
      destructive
      canConfirm
      onConfirm={() =>
        void bulk.run({ target: props.target, choice: { action: 'delete' } }).catch(() => undefined)
      }
      bulk={bulk}
      onClose={props.onClose}
    >
      <p className="text-sm">{t('bulk.delete.body')}</p>
    </Frame>
  );
}
