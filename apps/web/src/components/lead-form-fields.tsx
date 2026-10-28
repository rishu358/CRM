'use client';

import { Checkbox, Input, Select, Textarea } from '@crm/ui';
import { t } from '../lib/i18n';

/**
 * The fields of a website lead form, drawn from the form's own definition (ADR-0065 5.1).
 *
 * One component for the visitor's page and for the editor's preview, so what an administrator sees
 * while building is what a visitor gets. It draws text with React, which escapes it: a label, a help
 * text or an option is a company's own words, never markup, and nothing here uses
 * the raw-HTML escape hatch (a test keeps it that way for everything under `app/f/`).
 */

export interface FormFieldView {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly helpText: string | null | undefined;
  readonly options?: readonly { value: string; label: string }[] | undefined;
}

export type FieldValue = string | boolean | string[];
export type FieldValues = Record<string, FieldValue>;

/** The body a field's value becomes: numbers as numbers, an empty box as nothing at all. */
export function toBodyValue(field: FormFieldView, value: FieldValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length === 0 ? undefined : value;
  const text = value.trim();
  if (text === '') return undefined;
  if (field.type === 'number') {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : text;
  }
  return text;
}

const INPUT_TYPES: Readonly<Record<string, 'text' | 'email' | 'tel' | 'url' | 'number' | 'date'>> =
  {
    text: 'text',
    email: 'email',
    phone: 'tel',
    url: 'url',
    number: 'number',
    date: 'date',
  };

const AUTOCOMPLETE: Readonly<Record<string, string>> = {
  first_name: 'given-name',
  last_name: 'name',
  email: 'email',
  phone: 'tel',
  company: 'organization',
};

export function LeadFormFields({
  idPrefix,
  fields,
  values,
  errors,
  disabled = false,
  onChange,
}: {
  idPrefix: string;
  fields: readonly FormFieldView[];
  values: FieldValues;
  errors: Readonly<Record<string, string>>;
  disabled?: boolean;
  onChange: (key: string, value: FieldValue) => void;
}) {
  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const label = field.required
          ? `${field.label} (${t('publicForm.requiredMark')})`
          : field.label;
        const error = errors[field.key];
        const hint = field.helpText ?? undefined;
        const value = values[field.key];

        if (field.type === 'boolean') {
          return (
            <Checkbox
              key={field.key}
              id={id}
              label={label}
              {...(hint === undefined ? {} : { description: hint })}
              checked={value === true}
              disabled={disabled}
              onChange={(event) => onChange(field.key, event.target.checked)}
            />
          );
        }

        if (field.type === 'multi_picklist') {
          const chosen = Array.isArray(value) ? value : [];
          return (
            <fieldset
              key={field.key}
              className="space-y-2"
              aria-describedby={error ? `${id}-error` : undefined}
            >
              <legend className="text-sm font-medium">{label}</legend>
              {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
              {(field.options ?? []).map((option) => (
                <Checkbox
                  key={option.value}
                  id={`${id}-${option.value}`}
                  label={option.label}
                  checked={chosen.includes(option.value)}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      field.key,
                      event.target.checked
                        ? [...chosen, option.value]
                        : chosen.filter((entry) => entry !== option.value),
                    )
                  }
                />
              ))}
              {error === undefined ? null : (
                <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </fieldset>
          );
        }

        if (field.type === 'picklist') {
          return (
            <Select
              key={field.key}
              id={id}
              label={label}
              hint={hint}
              error={error}
              value={typeof value === 'string' ? value : ''}
              disabled={disabled}
              onChange={(event) => onChange(field.key, event.target.value)}
            >
              <option value="">{t('publicForm.chooseOne')}</option>
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          );
        }

        if (field.type === 'long_text') {
          return (
            <Textarea
              key={field.key}
              id={id}
              label={label}
              hint={hint}
              error={error}
              rows={4}
              maxLength={2000}
              value={typeof value === 'string' ? value : ''}
              disabled={disabled}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          );
        }

        const inputType = INPUT_TYPES[field.type] ?? 'text';
        return (
          <Input
            key={field.key}
            id={id}
            label={label}
            hint={hint}
            error={error}
            type={inputType}
            autoComplete={AUTOCOMPLETE[field.key] ?? 'off'}
            maxLength={field.key === 'email' ? 254 : field.type === 'url' ? 500 : 500}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        );
      })}
    </div>
  );
}
