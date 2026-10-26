import type { FieldDefinitionView } from './fields';
import { describe, expect, it } from 'vitest';
import { editableFields, editValue } from './bulk';
import {
  filterableField,
  filterableFields,
  filterStrings,
  isCompleteCondition,
  listKey,
  listSearchParams,
  operatorNeedsValue,
  sortFromView,
  sortToView,
} from './list-view';
import {
  EMPTY_SELECTION,
  isAllMatching,
  tickEveryMatching,
  tickedVisible,
  toggleEveryVisible,
  toggleOne,
} from './selection';

const system = (key: string, type = 'text', options?: { value: string; label: string }[]) =>
  ({
    key,
    label: key,
    type,
    isSystem: true,
    isActive: true,
    options,
  }) as unknown as FieldDefinitionView;
const custom = (key: string, type: string) =>
  ({
    key,
    label: key,
    type,
    isSystem: false,
    isActive: true,
    writable: true,
  }) as unknown as FieldDefinitionView;

describe('what a list asks the API for', () => {
  it('builds one query string from the search, the conditions and the sort', () => {
    const params = listSearchParams(
      {
        q: 'priya',
        sort: '-created_at',
        conditions: [
          { field: 'last_name', operator: 'starts_with', value: 'S' },
          { field: 'phone', operator: 'is_null', value: '' },
        ],
      },
      { cursor: 'abc', extraFilters: ['pipeline_id:eq:x'] },
    );
    expect(params.get('q')).toBe('priya');
    expect(params.get('sort')).toBe('-created_at');
    expect(params.get('cursor')).toBe('abc');
    expect(params.get('limit')).toBe('50');
    expect(params.getAll('filter')).toEqual([
      'pipeline_id:eq:x',
      'last_name:starts_with:S',
      'phone:is_null:',
    ]);
  });

  it('leaves out an empty search and no cursor', () => {
    const params = listSearchParams({ q: '', conditions: [], sort: 'name' });
    expect(params.has('q')).toBe(false);
    expect(params.has('cursor')).toBe(false);
    expect(params.has('filter')).toBe(false);
  });

  it('keeps a colon inside a value intact, as the API splits only on the first two', () => {
    expect(
      filterStrings([{ field: 'website', operator: 'eq', value: 'https://a.example' }]),
    ).toEqual(['website:eq:https://a.example']);
  });

  it('gives equal lists one cache key and different lists different ones', () => {
    const a = { q: 'x', conditions: [], sort: 'name' };
    expect(listKey(a)).toBe(listKey({ ...a }));
    expect(listKey(a)).not.toBe(listKey({ ...a, q: 'y' }));
    expect(listKey(a)).not.toBe(listKey({ ...a, sort: '-name' }));
  });

  it('converts a sort between the list endpoint and a saved view', () => {
    expect(sortToView('-created_at')).toEqual({ field: 'created_at', direction: 'desc' });
    expect(sortToView('name')).toEqual({ field: 'name', direction: 'asc' });
    expect(sortFromView([{ field: 'name', direction: 'desc' }])).toBe('-name');
    expect(sortFromView([])).toBeNull();
  });
});

describe('which fields the filter builder offers, and how', () => {
  it('offers text columns text operators and a number column number operators', () => {
    expect(filterableField('contact', system('last_name'))?.operators).toContain('starts_with');
    const revenue = filterableField('account', system('employee_count', 'number'));
    expect(revenue?.valueKind).toBe('number');
    expect(revenue?.operators).toEqual(expect.arrayContaining(['gt', 'lte']));
  });

  it('never offers a reference (an id nobody can type) or a column the API cannot query', () => {
    expect(filterableField('contact', system('account_id'))).toBeNull();
    expect(filterableField('deal', system('stage_id'))).toBeNull();
    expect(filterableField('contact', system('no_such_column'))).toBeNull();
  });

  it('lets a system field with a list of answers be chosen, not typed', () => {
    const field = filterableField(
      'contact',
      system('lead_source', 'picklist', [{ value: 'web', label: 'Web' }]),
    );
    expect(field?.valueKind).toBe('picklist');
    expect(field?.options).toEqual([{ value: 'web', label: 'Web' }]);
  });

  it('offers a custom number only "is" and "is not", because the API compares custom values as text', () => {
    const field = filterableField('contact', custom('score', 'number'));
    expect(field?.operators).not.toContain('gt');
    expect(field?.operators).toEqual(expect.arrayContaining(['eq', 'neq']));
  });

  it('does not offer the custom types it cannot state honestly', () => {
    for (const type of ['currency', 'datetime', 'multi_picklist', 'user_lookup']) {
      expect(filterableField('contact', custom('x', type)), type).toBeNull();
    }
  });

  it('lists every offered field once, with the built-in dates', () => {
    const fields = filterableFields(
      'contact',
      [system('last_name'), custom('region', 'text'), { ...system('last_name'), isActive: true }],
      [{ key: 'created_at', label: 'Created' }],
    );
    expect(fields.map((field) => field.key)).toEqual(['last_name', 'region', 'created_at']);
  });
});

describe('conditions', () => {
  it('says which operators need a value and which rows are complete', () => {
    expect(operatorNeedsValue('is_null')).toBe(false);
    expect(operatorNeedsValue('eq')).toBe(true);
    expect(isCompleteCondition({ field: 'a', operator: 'is_not_null', value: '' })).toBe(true);
    expect(isCompleteCondition({ field: 'a', operator: 'eq', value: '  ' })).toBe(false);
    expect(isCompleteCondition({ field: 'a', operator: 'eq', value: 'x' })).toBe(true);
  });
});

describe('what a bulk edit offers for this person', () => {
  const defs = [
    { key: 'title', label: 'Title', type: 'text', isSystem: true, isActive: true, writable: true },
    {
      key: 'lead_source',
      label: 'Lead source',
      type: 'picklist',
      isSystem: true,
      isActive: true,
      writable: false,
    },
    { key: 'email', label: 'Email', type: 'email', isSystem: true, isActive: true, writable: true },
    custom('region', 'text'),
    { ...custom('score', 'currency') },
    { ...custom('old', 'text'), isActive: false },
    { ...custom('locked', 'text'), writable: false },
  ] as unknown as FieldDefinitionView[];

  it('offers the allowed system fields they may write, and the custom fields of a type it can enter', () => {
    const keys = editableFields('contact', defs).map((field) => field.key);
    expect(keys).toEqual(['title', 'region']);
  });

  it('does not offer email, whatever the metadata says', () => {
    expect(editableFields('contact', defs).some((field) => field.key === 'email')).toBe(false);
  });

  it('offers a deal stage only when the page has stages to choose from', () => {
    const dealDefs = [
      {
        key: 'stage_id',
        label: 'Stage',
        type: 'text',
        isSystem: true,
        isActive: true,
        writable: true,
      },
    ] as unknown as FieldDefinitionView[];
    expect(editableFields('deal', dealDefs)).toEqual([]);
    const withStages = editableFields('deal', dealDefs, [{ id: 's1', name: 'Won' }]);
    expect(withStages[0]?.input).toEqual({
      kind: 'select',
      options: [{ value: 's1', label: 'Won' }],
    });
  });

  it('turns what was typed into the JSON the API expects, and clears with null', () => {
    expect(editValue({ kind: 'number' }, '42', false)).toBe(42);
    expect(editValue({ kind: 'boolean' }, 'true', false)).toBe(true);
    expect(editValue({ kind: 'boolean' }, 'false', false)).toBe(false);
    expect(editValue({ kind: 'text' }, 'x', false)).toBe('x');
    expect(editValue({ kind: 'text' }, 'x', true)).toBeNull();
  });
});

describe('selection', () => {
  it('acts only on rows that are still on screen', () => {
    let state = toggleOne(toggleOne(EMPTY_SELECTION, 'a'), 'c');
    expect(tickedVisible(state, ['a', 'b', 'c'])).toEqual(['a', 'c']);
    // The list is filtered and "c" is gone: it is no longer selected.
    expect(tickedVisible(state, ['a', 'b'])).toEqual(['a']);
    state = toggleOne(state, 'a');
    expect(tickedVisible(state, ['a', 'b'])).toEqual([]);
  });

  it('ticks and unticks every row on screen', () => {
    const visible = ['a', 'b'];
    const all = toggleEveryVisible(EMPTY_SELECTION, visible);
    expect(tickedVisible(all, visible)).toEqual(['a', 'b']);
    expect(tickedVisible(toggleEveryVisible(all, visible), visible)).toEqual([]);
  });

  it('ends "every record this view matches" the moment the ticks change', () => {
    const visible = ['a', 'b'];
    const matching = tickEveryMatching(EMPTY_SELECTION, visible);
    expect(isAllMatching(matching, visible)).toBe(true);
    expect(isAllMatching(toggleOne(matching, 'a'), visible)).toBe(false);
    // And it does not outlive a row leaving the screen.
    expect(isAllMatching(matching, ['a', 'b', 'c'])).toBe(false);
    expect(isAllMatching(matching, [])).toBe(false);
  });
});
