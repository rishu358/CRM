'use client';

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EditIcon,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@crm/ui';
import type { CustomizableObjectName } from '@crm/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CURRENCIES,
  displayValue,
  draftFromValue,
  emptyDraft,
  isEmptyDraft,
  safeHref,
  valueFromDraft,
  type Draft,
  type MoneyDraft,
} from '../lib/custom-field-values';
import { ColumnChooser } from './column-chooser';
import { useFieldDefinitions, type FieldDefinitionView } from '../lib/fields';
import { DEFAULT_PREFERENCES } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';

/**
 * Custom fields on a record's screens (MVP_SPEC M9, ADR-0039).
 *
 * Everything here is drawn from the field definitions the API returns for this
 * person: a field they may not read is not in the list, so there is no box for it
 * and no empty row hinting that something is being withheld. What the screen does
 * not decide is who may *write* — the API refuses a write the role cannot make, and
 * the message is shown.
 *
 * Three pieces, because a field is met in three places: `CustomFieldControl` is one
 * box of the right kind; `useCustomFieldDrafts` and `CustomFieldsFields` are the
 * extra boxes of a "new record" dialog; `CustomFieldsCard` is the editable list on a
 * record's own page.
 */

/** The label a box carries: required ones are marked, for sighted and screen-reader users. */
function labelOf(definition: FieldDefinitionView): string {
  return definition.required ? `${definition.label} *` : definition.label;
}

/* -------------------------------------------------------------------------- */
/* One box                                                                    */
/* -------------------------------------------------------------------------- */

export function CustomFieldControl({
  definition,
  draft,
  onChange,
  error,
  id,
  labelHidden = false,
}: {
  definition: FieldDefinitionView;
  draft: Draft;
  onChange: (draft: Draft) => void;
  error?: string | undefined;
  id: string;
  labelHidden?: boolean;
}) {
  const label = labelOf(definition);
  const hint = labelHidden ? undefined : (definition.helpText ?? undefined);
  const common = { id, label, labelHidden, hint, error } as const;
  const required = definition.required ? ({ 'aria-required': true } as const) : {};

  switch (definition.type) {
    case 'long_text':
      return (
        <Textarea
          {...common}
          {...required}
          value={draft as string}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'boolean':
      return (
        <Select
          {...common}
          {...required}
          value={draft as string}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t('customFields.choose')}</option>
          <option value="true">{t('customFields.yes')}</option>
          <option value="false">{t('customFields.no')}</option>
        </Select>
      );

    case 'picklist': {
      const current = draft as string;
      const offered = (definition.options ?? []).filter((option) => option.isActive !== false);
      // A value a retired option stands for is still on the record: show it as what
      // it is, so saving the record does not silently change it.
      const retired = (definition.options ?? []).find(
        (option) => option.value === current && option.isActive === false,
      );
      return (
        <Select
          {...common}
          {...required}
          value={current}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t('customFields.choose')}</option>
          {offered.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {retired === undefined ? null : (
            <option value={retired.value}>
              {t('customFields.retired', { label: retired.label })}
            </option>
          )}
        </Select>
      );
    }

    case 'multi_picklist': {
      const selected = draft as readonly string[];
      const shown = (definition.options ?? []).filter(
        (option) => option.isActive !== false || selected.includes(option.value),
      );
      return (
        <fieldset
          className="space-y-2"
          aria-describedby={error === undefined ? undefined : `${id}-error`}
        >
          <legend className={labelHidden ? 'sr-only' : 'text-sm font-medium'}>{label}</legend>
          {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
          {shown.map((option) => (
            <Checkbox
              key={option.value}
              label={
                option.isActive === false
                  ? t('customFields.retired', { label: option.label })
                  : option.label
              }
              checked={selected.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((value) => value !== option.value),
                )
              }
            />
          ))}
          {error === undefined ? null : (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </fieldset>
      );
    }

    case 'currency': {
      const money = draft as MoneyDraft;
      const codes = definition.validation?.allowedCurrencies ?? [];
      const choices = codes.length > 0 ? codes : [...CURRENCIES];
      const options = choices.includes(money.currency) ? choices : [money.currency, ...choices];
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <Input
              {...common}
              {...required}
              error={undefined}
              hint={undefined}
              inputMode="decimal"
              value={money.amount}
              onChange={(event) => onChange({ ...money, amount: event.target.value })}
              wrapperClassName="w-44"
            />
            <Select
              id={`${id}-currency`}
              label={`${definition.label} (currency)`}
              labelHidden
              value={money.currency}
              onChange={(event) => onChange({ ...money, currency: event.target.value })}
              className="w-24"
            >
              {options.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </div>
          {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
          {error === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      );
    }

    case 'text':
    case 'number':
    case 'percent':
    case 'date':
    case 'datetime':
    case 'email':
    case 'phone':
    case 'url':
    case 'user_lookup': {
      const type =
        definition.type === 'email'
          ? 'email'
          : definition.type === 'phone'
            ? 'tel'
            : definition.type === 'url'
              ? 'url'
              : definition.type === 'date'
                ? 'date'
                : definition.type === 'datetime'
                  ? 'datetime-local'
                  : 'text';
      const numeric = definition.type === 'number' || definition.type === 'percent';
      return (
        <Input
          {...common}
          {...required}
          type={type}
          {...(numeric ? { inputMode: 'decimal' as const } : {})}
          {...(definition.validation?.maxLength === undefined
            ? {}
            : { maxLength: definition.validation.maxLength })}
          value={draft as string}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The extra boxes of a "new record" dialog                                   */
/* -------------------------------------------------------------------------- */

export interface CustomFieldDrafts {
  readonly definitions: readonly FieldDefinitionView[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly draftFor: (definition: FieldDefinitionView) => Draft;
  readonly set: (key: string, draft: Draft) => void;
  readonly errors: Readonly<Record<string, string>>;
  /** The values to send, or null if any box is unacceptable (and now says why). */
  readonly collect: () => Record<string, unknown> | null;
}

/**
 * The custom fields of a record being created.
 *
 * `collect` is the one place that decides whether the extra boxes are acceptable:
 * a required one that is empty, or one that cannot be read as its type, stops the
 * save with the message beside the box. An empty optional box sends nothing at all,
 * so "never filled in" is one state in the database and not two.
 */
export function useCustomFieldDrafts(objectType: CustomizableObjectName): CustomFieldDrafts {
  const query = useFieldDefinitions(objectType);
  const definitions = useMemo(
    // Only the boxes this person can write: a box the API will refuse is worse than none.
    () => (query.data?.data ?? []).filter((field) => !field.isSystem && field.writable),
    [query.data],
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  return {
    definitions,
    isPending: query.isPending,
    isError: query.isError,
    draftFor: (definition) => drafts[definition.key] ?? emptyDraft(definition),
    set: (key, draft) => {
      setDrafts((current) => ({ ...current, [key]: draft }));
      setErrors((current) => {
        if (!(key in current)) return current;
        const { [key]: _gone, ...rest } = current;
        return rest;
      });
    },
    errors,
    collect: () => {
      const next: Record<string, string> = {};
      const values: Record<string, unknown> = {};

      for (const definition of definitions) {
        const draft = drafts[definition.key] ?? emptyDraft(definition);
        if (isEmptyDraft(definition, draft)) {
          if (definition.required) next[definition.key] = t('customFields.required');
          continue;
        }
        const converted = valueFromDraft(definition, draft);
        if (!converted.ok) next[definition.key] = t(converted.error);
        else values[definition.key] = converted.value;
      }

      setErrors(next);
      return Object.keys(next).length > 0 ? null : values;
    },
  };
}

/** Heading and the boxes under it, for each section in the order the fields first appear. */
function groupBySection(
  definitions: readonly FieldDefinitionView[],
): { section: string | null; fields: FieldDefinitionView[] }[] {
  const groups: { section: string | null; fields: FieldDefinitionView[] }[] = [];
  for (const definition of definitions) {
    const group = groups.find((candidate) => candidate.section === definition.section);
    if (group === undefined) groups.push({ section: definition.section, fields: [definition] });
    else group.fields.push(definition);
  }
  return groups;
}

export function CustomFieldsFields({
  state,
  idPrefix,
}: {
  state: CustomFieldDrafts;
  idPrefix: string;
}) {
  if (state.isPending) {
    return (
      <div role="status" aria-label={t('common.loading')} className="space-y-3">
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (state.isError) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {t('customFields.loadError')}
      </p>
    );
  }
  if (state.definitions.length === 0) return null;

  return (
    <div className="space-y-4">
      {groupBySection(state.definitions).map((group) => (
        <div key={group.section ?? ''} className="space-y-4">
          {group.section === null ? null : (
            <h3 className="border-t border-border pt-4 text-sm font-semibold">{group.section}</h3>
          )}
          {group.fields.map((definition) => (
            <CustomFieldControl
              key={definition.id}
              id={`${idPrefix}-${definition.key}`}
              definition={definition}
              draft={state.draftFor(definition)}
              onChange={(draft) => state.set(definition.key, draft)}
              error={state.errors[definition.key]}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Custom fields as list columns                                              */
/* -------------------------------------------------------------------------- */

/** A custom column's key in a chooser, kept apart from the built-in column keys. */
export const CUSTOM_COLUMN_PREFIX = 'custom:';

export interface CustomColumns {
  readonly definitions: readonly FieldDefinitionView[];
  readonly chosen: readonly string[];
  readonly setChosen: (next: string[]) => void;
  /** The definitions the person has chosen to see, in the order the company set. */
  readonly chosenDefinitions: readonly FieldDefinitionView[];
}

/**
 * Which custom fields a list shows.
 *
 * None until somebody chooses: a company with forty custom fields must not get a
 * forty-column table by default. The options are the fields this person may read,
 * and nothing else, for the reason the column chooser already gives — a name in the
 * chooser is a leak even when every cell is blank. The choice is per visit; saved
 * views are what will remember it (MVP_SPEC M4).
 */
export function useCustomColumns(objectType: CustomizableObjectName): CustomColumns {
  const query = useFieldDefinitions(objectType);
  const definitions = useMemo(
    () => (query.data?.data ?? []).filter((field) => !field.isSystem),
    [query.data],
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const chosenDefinitions = definitions.filter((definition) =>
    chosen.includes(CUSTOM_COLUMN_PREFIX + definition.key),
  );
  return { definitions, chosen, setChosen, chosenDefinitions };
}

export function customColumnOptions(
  definitions: readonly FieldDefinitionView[],
): { key: string; text: string }[] {
  return definitions.map((definition) => ({
    key: CUSTOM_COLUMN_PREFIX + definition.key,
    text: definition.label,
  }));
}

/** The chooser keys for these field keys: only the ones that are custom fields this person can see. */
export function customColumnKeys(
  definitions: readonly FieldDefinitionView[],
  keys: readonly string[],
): string[] {
  const known = new Set(definitions.map((definition) => definition.key));
  return keys.filter((key) => known.has(key)).map((key) => CUSTOM_COLUMN_PREFIX + key);
}

/** The field keys behind chooser keys: what a saved view stores. */
export function customFieldKeys(chosen: readonly string[]): string[] {
  return chosen
    .filter((key) => key.startsWith(CUSTOM_COLUMN_PREFIX))
    .map((key) => key.slice(CUSTOM_COLUMN_PREFIX.length));
}

/** The chooser for the extras, or nothing when the company has defined none this person can see. */
export function CustomColumnsChooser({ state }: { state: CustomColumns }) {
  if (state.definitions.length === 0) return null;
  return (
    <ColumnChooser
      options={customColumnOptions(state.definitions)}
      selected={state.chosen}
      onChange={state.setChosen}
      buttonLabel={t('customFields.columns')}
      allowEmpty
    />
  );
}

/** One cell's text, from a record's `customFields`. Empty is empty, never "null". */
export function customCellText(definition: FieldDefinitionView, record: unknown): string {
  const values = (record as { customFields?: Record<string, unknown> }).customFields;
  return displayValue(definition, values?.[definition.key], DEFAULT_PREFERENCES, {
    yes: t('customFields.yes'),
    no: t('customFields.no'),
  });
}

/* -------------------------------------------------------------------------- */
/* The editable list on a record's page                                       */
/* -------------------------------------------------------------------------- */

function Value({ definition, value }: { definition: FieldDefinitionView; value: unknown }) {
  const text = displayValue(definition, value, DEFAULT_PREFERENCES, {
    yes: t('customFields.yes'),
    no: t('customFields.no'),
  });
  if (text === '') return <span className="text-muted-foreground">{t('field.empty')}</span>;

  const href = definition.type === 'url' ? safeHref(value) : null;
  if (href !== null) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline-offset-4 hover:underline"
      >
        {text}
      </a>
    );
  }
  return <span className="whitespace-pre-line break-words">{text}</span>;
}

function Row({
  definition,
  value,
  onSave,
}: {
  definition: FieldDefinitionView;
  value: unknown;
  onSave: (key: string, value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>('');
  const [error, setError] = useState<TranslationKey | null>(null);
  const editor = useRef<HTMLDivElement>(null);

  // Focus moves to the box when editing starts: a keyboard user who pressed Edit must land
  // where they can type. Done in code, as the rest of the app does, not with `autoFocus`.
  useEffect(() => {
    if (editing) editor.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, [editing]);

  const start = () => {
    setDraft(draftFromValue(definition, value));
    setError(null);
    setEditing(true);
  };

  const commit = () => {
    if (isEmptyDraft(definition, draft) && definition.required) {
      setError('customFields.required');
      return;
    }
    const converted = valueFromDraft(definition, draft);
    if (!converted.ok) {
      setError(converted.error);
      return;
    }
    setEditing(false);
    setError(null);
    if (JSON.stringify(converted.value) !== JSON.stringify(value ?? null)) {
      onSave(definition.key, converted.value);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[10rem_1fr] sm:gap-3">
      <span className="pt-1.5 text-sm text-muted-foreground">{definition.label}</span>

      {editing ? (
        <div ref={editor} className="space-y-2">
          <CustomFieldControl
            id={`record-${definition.key}`}
            definition={definition}
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setError(null);
            }}
            error={error === null ? undefined : t(error)}
            labelHidden
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={commit}>
              {t('field.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t('field.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="group flex items-start gap-2 text-sm">
          <div className="min-w-0 flex-1 px-2 pt-1.5">
            <Value definition={definition} value={value} />
          </div>
          {definition.writable ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('customFields.edit', { label: definition.label })}
              onClick={start}
              className="shrink-0 opacity-70 hover:opacity-100 focus-visible:opacity-100"
            >
              <EditIcon className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The custom fields of one record, editable in place.
 *
 * Renders nothing when the company has defined none this person can see: an empty
 * card titled "More details" would say there is something to add where there is not.
 */
export function CustomFieldsCard({
  objectType,
  values,
  onSave,
}: {
  objectType: CustomizableObjectName;
  /** The record's `customFields`, as the API returned it. */
  values: Record<string, unknown> | undefined;
  onSave: (key: string, value: unknown) => void;
}) {
  const query = useFieldDefinitions(objectType);
  const definitions = (query.data?.data ?? []).filter((field) => !field.isSystem);
  if (query.isPending || query.isError || definitions.length === 0) return null;

  return (
    <Card data-testid="custom-fields-card">
      <CardHeader title={t('customFields.title')} />
      <CardBody className="px-5 py-1">
        {groupBySection(definitions).map((group) => (
          <section key={group.section ?? ''} aria-label={group.section ?? t('customFields.title')}>
            {group.section === null ? null : (
              <h3 className="border-t border-border pb-1 pt-3 text-sm font-semibold first:border-t-0 first:pt-2">
                {group.section}
              </h3>
            )}
            <div className="divide-y divide-border">
              {group.fields.map((definition) => (
                <Row
                  key={definition.id}
                  definition={definition}
                  value={values?.[definition.key]}
                  onSave={onSave}
                />
              ))}
            </div>
          </section>
        ))}
      </CardBody>
    </Card>
  );
}
