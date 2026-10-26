'use client';

import {
  CUSTOM_FIELD_TYPES,
  MAX_PICKLIST_OPTIONS,
  isPicklistType,
  type CustomFieldType,
} from '@crm/core';
import type {
  CustomizableObjectName,
  FieldCreateInput,
  FieldDefinitionView,
  FieldUpdateInput,
} from '@crm/contracts';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Button,
  Checkbox,
  CloseIcon,
  Dialog,
  IconButton,
  Input,
  PlusIcon,
  Select,
} from '@crm/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiRequestError } from '../lib/api-client';
import { CURRENCIES } from '../lib/custom-field-values';
import { t, type TranslationKey } from '../lib/i18n';

/**
 * Add a custom field, or edit one (MVP_SPEC M9, ADR-0039).
 *
 * The form asks for what an administrator can decide and nothing else: the key is
 * made from the name by the server and the type is fixed once a field exists, so
 * neither is a box here (the type is shown, greyed, with the reason). A picklist's
 * options are edited as a list the person can reorder; an option that has been offered
 * can be switched off but not removed, and the screen says why rather than hiding the
 * remove button without comment.
 *
 * The server validates all of it again. This form is for feedback, never enforcement.
 */

interface OptionDraft {
  /** Stable across renders: reordering must not make React reuse the wrong row. */
  readonly rowKey: string;
  /** Present for an option that already exists; absent for a new one. */
  readonly value: string | undefined;
  readonly label: string;
  readonly isActive: boolean;
}

let nextRowKey = 0;
function rowKey(): string {
  nextRowKey += 1;
  return `option-${nextRowKey}`;
}

const SIZE_LIMIT_TYPES: readonly CustomFieldType[] = ['text', 'long_text', 'email'];
const RANGE_TYPES: readonly CustomFieldType[] = ['number', 'percent'];

function typeLabel(type: string): string {
  return t(`fields.type.${type}` as TranslationKey);
}

/** The server's reasons, beside what was typed, rather than one vague sentence. */
function messageOf(error: ApiRequestError): string {
  const reasons = error.error.details.map((detail) => detail.message).filter(Boolean);
  return reasons.length > 0 ? reasons.join(' ') : error.message;
}

function initialOptions(field: FieldDefinitionView | null): OptionDraft[] {
  if (field?.options !== undefined) {
    return field.options.map((option) => ({
      rowKey: rowKey(),
      value: option.value,
      label: option.label,
      isActive: option.isActive !== false,
    }));
  }
  return [
    { rowKey: rowKey(), value: undefined, label: '', isActive: true },
    { rowKey: rowKey(), value: undefined, label: '', isActive: true },
  ];
}

export function FieldDialog({
  objectType,
  field,
  pending,
  error,
  onSubmit,
  onClose,
  onReload,
}: {
  objectType: CustomizableObjectName;
  /** The field being edited, or null to add one. */
  field: FieldDefinitionView | null;
  pending: boolean;
  error: ApiRequestError | null;
  onSubmit: (input: FieldCreateInput | FieldUpdateInput) => void;
  onClose: () => void;
  onReload: () => void;
}) {
  const editing = field !== null;
  const [label, setLabel] = useState(field?.label ?? '');
  const [type, setType] = useState<CustomFieldType>((field?.type as CustomFieldType) ?? 'text');
  const [required, setRequired] = useState(field?.required ?? false);
  const [section, setSection] = useState(field?.section ?? '');
  const [helpText, setHelpText] = useState(field?.helpText ?? '');
  const [options, setOptions] = useState<OptionDraft[]>(() => initialOptions(field));
  const [minLength, setMinLength] = useState(String(field?.validation?.minLength ?? ''));
  const [maxLength, setMaxLength] = useState(String(field?.validation?.maxLength ?? ''));
  const [min, setMin] = useState(field?.validation?.min ?? '');
  const [max, setMax] = useState(field?.validation?.max ?? '');
  const [currencies, setCurrencies] = useState<readonly string[]>(
    field?.validation?.allowedCurrencies ?? [],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const nameBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameBox.current?.focus();
  }, []);

  const picklist = isPicklistType(type);
  const conflicted = error?.code === 'VERSION_CONFLICT';

  const move = (index: number, by: -1 | 1) =>
    setOptions((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return next;
    });

  const limits = (): FieldCreateInput['validation'] | 'invalid' => {
    const result: NonNullable<FieldCreateInput['validation']> = {};
    if (SIZE_LIMIT_TYPES.includes(type)) {
      for (const [key, text] of [
        ['minLength', minLength],
        ['maxLength', maxLength],
      ] as const) {
        if (text.trim() === '') continue;
        if (!/^\d+$/.test(text.trim())) return 'invalid';
        result[key] = Number(text.trim());
      }
    }
    if (RANGE_TYPES.includes(type)) {
      if (min.trim() !== '') result.min = min.trim();
      if (max.trim() !== '') result.max = max.trim();
    }
    if (type === 'currency' && currencies.length > 0) result.allowedCurrencies = [...currencies];
    return result;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);

    if (label.trim() === '') {
      setProblem(t('customFields.required'));
      return;
    }
    const validation = limits();
    if (validation === 'invalid') {
      setProblem(t('customFields.error.number'));
      return;
    }

    const optionInputs = options.map((option) => ({
      ...(option.value === undefined ? {} : { value: option.value }),
      label: option.label,
      isActive: option.isActive,
    }));
    const common = {
      label: label.trim(),
      required,
      ...(picklist ? { options: optionInputs } : {}),
      ...(Object.keys(validation ?? {}).length > 0 || editing ? { validation } : {}),
    };

    if (field === null) {
      onSubmit({
        objectType,
        type,
        ...common,
        ...(section.trim() === '' ? {} : { section: section.trim() }),
        ...(helpText.trim() === '' ? {} : { helpText: helpText.trim() }),
      } satisfies FieldCreateInput);
    } else {
      onSubmit({
        version: field.version,
        ...common,
        section: section.trim() === '' ? null : section.trim(),
        helpText: helpText.trim() === '' ? null : helpText.trim(),
      } satisfies FieldUpdateInput);
    }
  };

  return (
    <Dialog
      title={
        editing ? t('fields.dialog.editTitle', { label: field.label }) : t('fields.dialog.addTitle')
      }
      closeLabel={t('common.close')}
      onClose={onClose}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <Input
          label={t('fields.form.label')}
          hint={t('fields.form.label.hint')}
          aria-required="true"
          value={label}
          maxLength={80}
          ref={nameBox}
          onChange={(event) => setLabel(event.target.value)}
        />

        <Select
          label={t('fields.form.type')}
          hint={editing ? t('fields.form.type.locked') : undefined}
          value={type}
          disabled={editing}
          onChange={(event) => setType(event.target.value as CustomFieldType)}
        >
          {CUSTOM_FIELD_TYPES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {typeLabel(candidate)}
            </option>
          ))}
        </Select>

        <Checkbox
          label={t('fields.form.required')}
          description={t('fields.form.required.description')}
          checked={required}
          onChange={(event) => setRequired(event.target.checked)}
        />

        {picklist ? (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t('fields.form.options')}</legend>
            <p className="text-sm text-muted-foreground">{t('fields.form.options.hint')}</p>
            <ol className="space-y-2">
              {options.map((option, index) => (
                <li key={option.rowKey} className="flex items-center gap-2">
                  <Input
                    label={t('fields.form.option.label', { n: index + 1 })}
                    labelHidden
                    value={option.label}
                    maxLength={80}
                    wrapperClassName="min-w-0 flex-1"
                    onChange={(event) =>
                      setOptions((current) =>
                        current.map((candidate) =>
                          candidate.rowKey === option.rowKey
                            ? { ...candidate, label: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                  <Checkbox
                    label={t('fields.form.option.offered')}
                    checked={option.isActive}
                    className="shrink-0"
                    onChange={(event) =>
                      setOptions((current) =>
                        current.map((candidate) =>
                          candidate.rowKey === option.rowKey
                            ? { ...candidate, isActive: event.target.checked }
                            : candidate,
                        ),
                      )
                    }
                  />
                  <IconButton
                    label={t('fields.form.option.up', { n: index + 1 })}
                    icon={<ArrowUpIcon className="h-4 w-4" />}
                    size="icon-sm"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <IconButton
                    label={t('fields.form.option.down', { n: index + 1 })}
                    icon={<ArrowDownIcon className="h-4 w-4" />}
                    size="icon-sm"
                    disabled={index === options.length - 1}
                    onClick={() => move(index, 1)}
                  />
                  {option.value === undefined ? (
                    <IconButton
                      label={t('fields.form.option.remove', { n: index + 1 })}
                      icon={<CloseIcon className="h-4 w-4" />}
                      size="icon-sm"
                      onClick={() =>
                        setOptions((current) =>
                          current.filter((candidate) => candidate.rowKey !== option.rowKey),
                        )
                      }
                    />
                  ) : (
                    // Same width as the remove button, so the rows line up whether or not
                    // an option can be removed.
                    <span aria-hidden="true" className="inline-block h-8 w-8 shrink-0" />
                  )}
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={options.length >= MAX_PICKLIST_OPTIONS}
              onClick={() =>
                setOptions((current) => [
                  ...current,
                  { rowKey: rowKey(), value: undefined, label: '', isActive: true },
                ])
              }
            >
              <PlusIcon className="h-4 w-4" />
              {t('fields.form.options.add')}
            </Button>
          </fieldset>
        ) : null}

        {SIZE_LIMIT_TYPES.includes(type) || RANGE_TYPES.includes(type) || type === 'currency' ? (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t('fields.form.limits')}</legend>

            {SIZE_LIMIT_TYPES.includes(type) ? (
              <div className="grid grid-cols-2 gap-3">
                {type === 'email' ? null : (
                  <Input
                    label={t('fields.form.minLength')}
                    inputMode="numeric"
                    value={minLength}
                    onChange={(event) => setMinLength(event.target.value)}
                  />
                )}
                <Input
                  label={t('fields.form.maxLength')}
                  inputMode="numeric"
                  value={maxLength}
                  onChange={(event) => setMaxLength(event.target.value)}
                />
              </div>
            ) : null}

            {RANGE_TYPES.includes(type) ? (
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={t('fields.form.min')}
                  inputMode="decimal"
                  value={min}
                  onChange={(event) => setMin(event.target.value)}
                />
                <Input
                  label={t('fields.form.max')}
                  inputMode="decimal"
                  value={max}
                  onChange={(event) => setMax(event.target.value)}
                />
              </div>
            ) : null}

            {type === 'currency' ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('fields.form.currencies.hint')}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {CURRENCIES.map((code) => (
                    <Checkbox
                      key={code}
                      label={code}
                      checked={currencies.includes(code)}
                      onChange={(event) =>
                        setCurrencies((current) =>
                          event.target.checked
                            ? [...current, code]
                            : current.filter((candidate) => candidate !== code),
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        <Input
          label={t('fields.form.section')}
          hint={t('fields.form.section.hint')}
          value={section}
          maxLength={60}
          onChange={(event) => setSection(event.target.value)}
        />
        <Input
          label={t('fields.form.help')}
          hint={t('fields.form.help.hint')}
          value={helpText}
          maxLength={280}
          onChange={(event) => setHelpText(event.target.value)}
        />

        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}

        {conflicted ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 p-3"
          >
            <div>
              <p className="text-sm font-medium">{t('fields.conflict.title')}</p>
              <p className="text-sm text-muted-foreground">{t('fields.conflict.description')}</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={onReload}>
              {t('fields.conflict.reload')}
            </Button>
          </div>
        ) : error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {messageOf(error)}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('field.cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {editing ? t('fields.form.save') : t('fields.form.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
