import { describe, expect, it } from 'vitest';
import { bulkActionSchema } from './bulk.js';
import { savedViewCreateSchema, savedViewUpdateSchema } from './saved-views.js';

const id = '0197c3f0-0000-7000-8000-000000000001';
const ids = { kind: 'ids' as const, ids: [id] };

describe('bulk action request', () => {
  it('accepts each action with its own parameters', () => {
    for (const body of [
      { objectType: 'contact', action: 'delete', target: ids },
      { objectType: 'contact', action: 'assign', ownerId: id, target: ids },
      { objectType: 'lead', action: 'edit', changes: { status: 'qualified' }, target: ids },
      { objectType: 'deal', action: 'tag_add', tags: ['VIP', ' hot  lead '], target: ids },
      {
        objectType: 'account',
        action: 'tag_remove',
        tags: ['x'],
        target: { kind: 'filter', filter: { conditions: [] }, after: id },
      },
    ]) {
      expect(bulkActionSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it('normalises tag names, and defaults dryRun to false', () => {
    const parsed = bulkActionSchema.parse({
      objectType: 'deal',
      action: 'tag_add',
      tags: ['  hot   lead '],
      target: ids,
    });
    expect(parsed.dryRun).toBe(false);
    expect('tags' in parsed && parsed.tags).toEqual(['hot lead']);
  });

  it.each([
    ['an unknown action', { objectType: 'contact', action: 'merge', target: ids }],
    ['an unknown key', { objectType: 'contact', action: 'delete', target: ids, force: true }],
    [
      'an object that has no bulk actions',
      { objectType: 'activity', action: 'delete', target: ids },
    ],
    [
      'a key that belongs to another action',
      { objectType: 'contact', action: 'delete', target: ids, ownerId: id },
    ],
    ['no ids', { objectType: 'contact', action: 'delete', target: { kind: 'ids', ids: [] } }],
    [
      '201 ids',
      {
        objectType: 'contact',
        action: 'delete',
        target: { kind: 'ids', ids: Array.from({ length: 201 }, () => id) },
      },
    ],
    [
      'an id that is not one',
      { objectType: 'contact', action: 'delete', target: { kind: 'ids', ids: ['1'] } },
    ],
    ['an empty change', { objectType: 'contact', action: 'edit', changes: {}, target: ids }],
    [
      'a field key with SQL in it',
      { objectType: 'contact', action: 'edit', changes: { 'a; drop table': 1 }, target: ids },
    ],
    [
      'six tags',
      {
        objectType: 'contact',
        action: 'tag_add',
        tags: ['a', 'b', 'c', 'd', 'e', 'f'],
        target: ids,
      },
    ],
    [
      'the same tag twice in another case',
      { objectType: 'contact', action: 'tag_add', tags: ['Vip', 'vip'], target: ids },
    ],
    [
      'a tag with a control character',
      { objectType: 'contact', action: 'tag_add', tags: ['a\u0007'], target: ids },
    ],
    [
      'a filter with an unknown operator',
      {
        objectType: 'contact',
        action: 'delete',
        target: {
          kind: 'filter',
          filter: { conditions: [{ field: 'a', operator: 'like', value: 'x' }] },
        },
      },
    ],
  ])('refuses %s', (_name, body) => {
    expect(bulkActionSchema.safeParse(body).success).toBe(false);
  });
});

describe('saved view requests', () => {
  it('defaults to private, no conditions, no columns and no sort', () => {
    const parsed = savedViewCreateSchema.parse({ objectType: 'contact', name: ' Mine ' });
    expect(parsed).toMatchObject({
      name: 'Mine',
      visibility: 'private',
      filters: { conditions: [] },
      columns: [],
      sort: [],
    });
  });

  it.each([
    ['a blank name', { objectType: 'contact', name: '   ' }],
    ['a name over 80 characters', { objectType: 'contact', name: 'x'.repeat(81) }],
    ['an unknown visibility', { objectType: 'contact', name: 'a', visibility: 'world' }],
    [
      'two sorts',
      {
        objectType: 'contact',
        name: 'a',
        sort: [
          { field: 'a', direction: 'asc' },
          { field: 'b', direction: 'asc' },
        ],
      },
    ],
    [
      'eleven conditions',
      {
        objectType: 'contact',
        name: 'a',
        filters: {
          conditions: Array.from({ length: 11 }, () => ({
            field: 'a',
            operator: 'eq',
            value: 'x',
          })),
        },
      },
    ],
    [
      'a condition value over 256 characters',
      {
        objectType: 'contact',
        name: 'a',
        filters: { conditions: [{ field: 'a', operator: 'eq', value: 'x'.repeat(257) }] },
      },
    ],
    [
      '31 columns',
      { objectType: 'contact', name: 'a', columns: Array.from({ length: 31 }, (_, i) => `c${i}`) },
    ],
    ['an object with no saved views', { objectType: 'activity', name: 'a' }],
    ['an unknown key', { objectType: 'contact', name: 'a', sql: 'x' }],
  ])('refuses %s', (_name, body) => {
    expect(savedViewCreateSchema.safeParse(body).success).toBe(false);
  });

  it('needs a version to update, and refuses to change the object type', () => {
    expect(savedViewUpdateSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(savedViewUpdateSchema.safeParse({ name: 'x', version: 1 }).success).toBe(true);
    expect(savedViewUpdateSchema.safeParse({ objectType: 'deal', version: 1 }).success).toBe(false);
  });
});
