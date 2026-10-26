'use client';

import { VIEW_MAX_CONDITIONS, type BusinessObjectType } from '@crm/core';
import type { FilterOperator, SavedView, ViewCondition } from '@crm/contracts';
import {
  Badge,
  Button,
  CloseIcon,
  Dialog,
  DialogFooter,
  FilterIcon,
  Input,
  PlusIcon,
  Select,
  ViewsIcon,
} from '@crm/ui';
import { useMemo, useState } from 'react';
import type { ApiRequestError } from '../lib/api-client';
import { useFieldDefinitions } from '../lib/fields';
import { t } from '../lib/i18n';
import {
  filterableFields,
  isCompleteCondition,
  operatorNeedsValue,
  sortToView,
  type FilterableField,
  type ListView,
} from '../lib/list-view';
import {
  useCreateSavedView,
  useDeleteSavedView,
  useSavedViews,
  useUpdateSavedView,
} from '../lib/saved-views';

/**
 * Money columns are stored in minor units (paise), so a figure typed here would be compared
 * 100 times too small. Until the builder converts, they are not offered rather than offered wrong.
 */
const MONEY_COLUMNS: ReadonlySet<string> = new Set(['annual_revenue', 'amount']);

const BUILT_IN = [
  { key: 'created_at', label: t('field.createdAt') },
  { key: 'updated_at', label: t('field.updatedAt') },
];

const VISIBILITY_LABEL = {
  private: 'views.visibility.private',
  team: 'views.visibility.team',
  tenant: 'views.visibility.tenant',
} as const;

type Visibility = SavedView['visibility'];

function errorText(error: ApiRequestError | null): string | null {
  if (error === null) return null;
  if (error.code === 'FORBIDDEN') return t('views.error.forbidden');
  if (error.code === 'VERSION_CONFLICT') return t('views.error.conflict');
  return error.error.details[0]?.message ?? t('error.generic');
}

function operatorLabel(operator: FilterOperator, field: FilterableField): string {
  const dated = field.valueKind === 'date' || field.valueKind === 'timestamp';
  switch (operator) {
    case 'eq':
      return t('filter.op.eq');
    case 'neq':
      return t('filter.op.neq');
    case 'contains':
      return t('filter.op.contains');
    case 'starts_with':
      return t('filter.op.starts_with');
    case 'is_null':
      return t('filter.op.is_null');
    case 'is_not_null':
      return t('filter.op.is_not_null');
    case 'gt':
      return dated ? t('filter.op.date.gt') : t('filter.op.num.gt');
    case 'gte':
      return dated ? t('filter.op.date.gte') : t('filter.op.num.gte');
    case 'lt':
      return dated ? t('filter.op.date.lt') : t('filter.op.num.lt');
    case 'lte':
      return dated ? t('filter.op.date.lte') : t('filter.op.num.lte');
    case 'in':
      return t('filter.op.eq');
  }
}

/**
 * The search, filters, sort and saved views of a list (MVP_SPEC M4, ADR-0056).
 *
 * Everything offered here comes from the field metadata the API returned for this person, so a
 * field they may not read is not a choice (CLAUDE.md §5.4), and a custom field is filterable the
 * moment it exists. A saved view is shown by its name only; whether it can be used is the API's
 * `applicable`, and the list endpoint checks every condition again when it is applied.
 */
export function ListViewBar({
  objectType,
  view,
}: {
  objectType: BusinessObjectType;
  view: ListView;
}) {
  const definitions = useFieldDefinitions(objectType);
  const views = useSavedViews(objectType);
  const [dialog, setDialog] = useState<'filters' | 'save' | 'manage' | null>(null);
  const update = useUpdateSavedView();

  const fields = useMemo(
    () =>
      filterableFields(objectType, definitions.data?.data ?? [], BUILT_IN).filter(
        (field) => !MONEY_COLUMNS.has(field.key),
      ),
    [objectType, definitions.data],
  );
  const fieldByKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);

  const all = views.data?.data ?? [];
  const mine = all.filter((candidate) => candidate.isMine);
  const shared = all.filter((candidate) => !candidate.isMine);
  const active = view.activeView;
  // The version moves on every save, so the copy in the list is the current one.
  const current =
    active === null ? null : (all.find((candidate) => candidate.id === active.id) ?? active);

  const sortOptions = useMemo(() => {
    const sortable = fields.filter((field) => field.valueKind !== 'boolean');
    const options = sortable.flatMap((field) => [
      { value: field.key, label: t('views.sort.asc', { field: field.label }) },
      { value: `-${field.key}`, label: t('views.sort.desc', { field: field.label }) },
    ]);
    // A sort the builder does not list (a column header the table offers) must still show as chosen.
    return options.some((option) => option.value === view.sort)
      ? options
      : [{ value: view.sort, label: sortToView(view.sort).field }, ...options];
  }, [fields, view.sort]);

  const saveCurrent = () => {
    if (current === null) return;
    update.mutate(
      {
        id: current.id,
        input: {
          filters: {
            ...(view.q.length > 0 ? { q: view.q } : {}),
            conditions: [...view.conditions],
          },
          columns: [...view.currentColumns],
          sort: [sortToView(view.sort)],
          version: current.version,
        },
      },
      {
        onSuccess: (response) => view.applyView(response.data),
      },
    );
  };

  return (
    <div className="mb-4 space-y-2" role="group" aria-label={t('views.bar')} data-testid="view-bar">
      <div className="flex flex-wrap items-end gap-2">
        {views.isError && views.error.status === 403 ? null : (
          <Select
            label={t('views.view')}
            value={current?.id ?? ''}
            onChange={(event) => {
              const next = all.find((candidate) => candidate.id === event.target.value) ?? null;
              view.applyView(next);
            }}
            className="w-52"
            data-testid="view-picker"
          >
            <option value="">{t('views.all')}</option>
            {mine.length === 0 ? null : (
              <optgroup label={t('views.mine')}>
                {mine.map((candidate) => (
                  <ViewOption key={candidate.id} view={candidate} />
                ))}
              </optgroup>
            )}
            {shared.length === 0 ? null : (
              <optgroup label={t('views.shared')}>
                {shared.map((candidate) => (
                  <ViewOption key={candidate.id} view={candidate} />
                ))}
              </optgroup>
            )}
          </Select>
        )}

        {views.isError && views.error.status !== 403 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('views.loadError')}
          </p>
        ) : null}

        <Button variant="outline" onClick={() => setDialog('filters')} data-testid="filters-button">
          <FilterIcon className="h-4 w-4" />
          {t('views.filters')}
          {view.conditions.length > 0 ? <Badge>{view.conditions.length}</Badge> : null}
        </Button>

        <Select
          label={t('views.sortBy')}
          value={view.sort}
          onChange={(event) => view.setSort(event.target.value)}
          className="w-56"
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>

        {view.isFiltered ? (
          <Button
            variant="ghost"
            onClick={() => view.setConditions([])}
            disabled={view.conditions.length === 0}
          >
            {t('views.clearFilters')}
          </Button>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {current?.isMine === true && view.isDirty ? (
            <Button variant="outline" onClick={saveCurrent} loading={update.isPending}>
              {t('views.update')}
            </Button>
          ) : null}
          {view.isDirty || view.isFiltered ? (
            <Button variant="outline" onClick={() => setDialog('save')} data-testid="save-view">
              <ViewsIcon className="h-4 w-4" />
              {t('views.saveAs')}
            </Button>
          ) : null}
          {current?.isMine === true ? (
            <Button variant="ghost" onClick={() => setDialog('manage')}>
              {t('views.manage')}
            </Button>
          ) : null}
        </div>
      </div>

      {update.error === null ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorText(update.error)}
        </p>
      )}

      {view.conditions.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label={t('views.activeFilters')}>
          {view.conditions.map((condition, index) => {
            const field = fieldByKey.get(condition.field);
            const label = field?.label ?? condition.field;
            const operator =
              field === undefined ? condition.operator : operatorLabel(condition.operator, field);
            const text = operatorNeedsValue(condition.operator)
              ? `${label} ${operator} ${valueLabel(field, condition.value)}`
              : `${label} ${operator}`;
            return (
              <li
                key={`${condition.field}-${index}`}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs"
              >
                <span>{text}</span>
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={t('views.removeFilter', { filter: text })}
                  onClick={() =>
                    view.setConditions(view.conditions.filter((_, position) => position !== index))
                  }
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {dialog === 'filters' ? (
        <FilterDialog
          fields={fields}
          initial={view.conditions}
          loading={definitions.isPending}
          onApply={(next) => {
            view.setConditions(next);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'save' ? (
        <SaveViewDialog
          objectType={objectType}
          view={view}
          onSaved={(saved) => {
            view.applyView(saved);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'manage' && current !== null ? (
        <ManageViewDialog
          current={current}
          onDeleted={() => {
            view.applyView(null);
            setDialog(null);
          }}
          onSaved={(saved) => {
            view.applyView(saved);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function ViewOption({ view }: { view: SavedView }) {
  return (
    <option value={view.id} disabled={!view.applicable}>
      {view.applicable ? view.name : t('views.unavailable', { name: view.name })}
    </option>
  );
}

function valueLabel(field: FilterableField | undefined, value: string): string {
  if (field === undefined) return value;
  if (field.valueKind === 'boolean') {
    return value === 'true' ? t('customFields.yes') : t('customFields.no');
  }
  if (field.valueKind === 'picklist') {
    return field.options.find((option) => option.value === value)?.label ?? value;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

function FilterDialog({
  fields,
  initial,
  loading,
  onApply,
  onClose,
}: {
  fields: readonly FilterableField[];
  initial: readonly ViewCondition[];
  loading: boolean;
  onApply: (conditions: ViewCondition[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ViewCondition[]>(() => [...initial]);
  const first = fields[0];

  const change = (index: number, patch: Partial<ViewCondition>) =>
    setDraft((rows) =>
      rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );

  const add = () => {
    if (first === undefined) return;
    setDraft((rows) => [
      ...rows,
      { field: first.key, operator: first.operators[0] ?? 'eq', value: '' },
    ]);
  };

  const incomplete = draft.some((row) => !isCompleteCondition(row));

  return (
    <Dialog
      title={t('views.filters.title')}
      description={t('views.filters.description')}
      closeLabel={t('common.close')}
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-3" data-testid="filter-dialog">
        {loading ? <p className="text-sm text-muted-foreground">{t('common.loading')}</p> : null}
        {draft.length === 0 && !loading ? (
          <p className="text-sm text-muted-foreground">{t('views.filters.none')}</p>
        ) : null}

        {draft.map((row, index) => {
          const field = fields.find((candidate) => candidate.key === row.field);
          return (
            <div
              key={index}
              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
              role="group"
              aria-label={t('views.filters.row', { number: index + 1 })}
            >
              <Select
                label={t('views.filters.field')}
                value={row.field}
                onChange={(event) => {
                  const next = fields.find((candidate) => candidate.key === event.target.value);
                  change(index, {
                    field: event.target.value,
                    operator: next?.operators[0] ?? 'eq',
                    value: '',
                  });
                }}
              >
                {fields.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.label}
                  </option>
                ))}
              </Select>
              <Select
                label={t('views.filters.operator')}
                value={row.operator}
                onChange={(event) =>
                  change(index, {
                    operator: event.target.value as FilterOperator,
                    value: operatorNeedsValue(event.target.value as FilterOperator)
                      ? row.value
                      : '',
                  })
                }
              >
                {(field?.operators ?? []).map((operator) => (
                  <option key={operator} value={operator}>
                    {field === undefined ? operator : operatorLabel(operator, field)}
                  </option>
                ))}
              </Select>
              {operatorNeedsValue(row.operator) ? (
                <ConditionValue
                  field={field}
                  value={row.value}
                  onChange={(value) => change(index, { value })}
                />
              ) : (
                <div aria-hidden="true" />
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft((rows) => rows.filter((_, position) => position !== index))}
                aria-label={t('views.filters.remove', { number: index + 1 })}
              >
                <CloseIcon className="h-4 w-4" />
              </Button>
            </div>
          );
        })}

        <Button
          variant="outline"
          size="sm"
          onClick={add}
          disabled={first === undefined || draft.length >= VIEW_MAX_CONDITIONS}
        >
          <PlusIcon className="h-4 w-4" />
          {t('views.filters.add')}
        </Button>
        {incomplete ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('views.filters.incomplete')}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('field.cancel')}
        </Button>
        <Button
          onClick={() => onApply(draft.filter(isCompleteCondition))}
          disabled={incomplete}
          data-testid="filters-apply"
        >
          {t('views.filters.apply')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ConditionValue({
  field,
  value,
  onChange,
}: {
  field: FilterableField | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const label = t('views.filters.value');
  switch (field?.valueKind) {
    case 'boolean':
      return (
        <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('bulk.edit.chooseValue')}</option>
          <option value="true">{t('customFields.yes')}</option>
          <option value="false">{t('customFields.no')}</option>
        </Select>
      );
    case 'picklist':
      return (
        <Select label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('bulk.edit.chooseValue')}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
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
        />
      );
    case 'date':
    case 'timestamp':
      return (
        <Input
          label={label}
          type="date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'text':
    case undefined:
      return (
        <Input
          label={label}
          value={value}
          maxLength={256}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Save, rename, share, delete                                                */
/* -------------------------------------------------------------------------- */

function VisibilitySelect({
  value,
  onChange,
}: {
  value: Visibility;
  onChange: (value: Visibility) => void;
}) {
  return (
    <Select
      label={t('views.visibility')}
      hint={t('views.visibility.hint')}
      value={value}
      onChange={(event) => onChange(event.target.value as Visibility)}
    >
      {(['private', 'team', 'tenant'] as const).map((option) => (
        <option key={option} value={option}>
          {t(VISIBILITY_LABEL[option])}
        </option>
      ))}
    </Select>
  );
}

function SaveViewDialog({
  objectType,
  view,
  onSaved,
  onClose,
}: {
  objectType: BusinessObjectType;
  view: ListView;
  onSaved: (saved: SavedView) => void;
  onClose: () => void;
}) {
  const create = useCreateSavedView();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');

  const submit = () =>
    create.mutate(
      {
        objectType,
        name: name.trim(),
        visibility,
        filters: { ...(view.q.length > 0 ? { q: view.q } : {}), conditions: [...view.conditions] },
        columns: [...view.currentColumns],
        sort: [sortToView(view.sort)],
      },
      { onSuccess: (response) => onSaved(response.data) },
    );

  return (
    <Dialog
      title={t('views.save.title')}
      description={t('views.save.description')}
      closeLabel={t('common.close')}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim().length > 0) submit();
        }}
        data-testid="save-view-dialog"
      >
        <Input
          label={t('views.name')}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          disabled={create.isPending}
        />
        <VisibilitySelect value={visibility} onChange={setVisibility} />
        {create.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errorText(create.error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={onClose} disabled={create.isPending}>
            {t('field.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={name.trim().length === 0}>
            {t('field.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function ManageViewDialog({
  current,
  onSaved,
  onDeleted,
  onClose,
}: {
  current: SavedView;
  onSaved: (saved: SavedView) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const update = useUpdateSavedView();
  const remove = useDeleteSavedView();
  const [name, setName] = useState(current.name);
  const [visibility, setVisibility] = useState<Visibility>(current.visibility);
  const [confirming, setConfirming] = useState(false);
  const pending = update.isPending || remove.isPending;
  const error = errorText(update.error ?? remove.error);

  return (
    <Dialog
      title={t('views.manage.title')}
      closeLabel={t('common.close')}
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate(
            { id: current.id, input: { name: name.trim(), visibility, version: current.version } },
            { onSuccess: (response) => onSaved(response.data) },
          );
        }}
        data-testid="manage-view-dialog"
      >
        <Input
          label={t('views.name')}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          disabled={pending}
        />
        <VisibilitySelect value={visibility} onChange={setVisibility} />
        {error === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {confirming ? (
            <Button
              variant="destructive"
              type="button"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { id: current.id, version: current.version },
                  { onSuccess: onDeleted },
                )
              }
              data-testid="delete-view-confirm"
            >
              {t('views.delete.confirm')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              type="button"
              onClick={() => setConfirming(true)}
              disabled={pending}
            >
              {t('views.delete')}
            </Button>
          )}
          <Button variant="ghost" type="button" onClick={onClose} disabled={pending}>
            {t('field.cancel')}
          </Button>
          <Button type="submit" loading={update.isPending} disabled={name.trim().length === 0}>
            {t('field.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
