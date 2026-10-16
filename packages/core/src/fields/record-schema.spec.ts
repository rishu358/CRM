import { describe, expect, it } from 'vitest';
import {
  activeFields,
  buildCustomFieldsPatchSchema,
  buildCustomFieldsSchema,
  filterableFieldKeys,
  sortableFieldKeys,
} from './record-schema.js';
import type { FieldDefinition } from './types.js';

const definitions: FieldDefinition[] = [
  {
    key: 'nickname',
    label: 'Nickname',
    type: 'text',
    required: false,
    isSystem: false,
    isActive: true,
    position: 2,
  },
  {
    key: 'gstin',
    label: 'GSTIN',
    type: 'text',
    required: true,
    isSystem: false,
    isActive: true,
    position: 1,
  },
  {
    key: 'notes',
    label: 'Notes',
    type: 'long_text',
    required: false,
    isSystem: false,
    isActive: true,
    position: 3,
  },
  {
    key: 'legacy_code',
    label: 'Legacy code',
    type: 'text',
    required: false,
    isSystem: false,
    isActive: false,
    position: 4,
  },
];

describe('buildCustomFieldsSchema', () => {
  const schema = buildCustomFieldsSchema(definitions);

  it('accepts a valid payload', () => {
    expect(schema.safeParse({ gstin: '29ABCDE1234F1Z5', nickname: 'Priya' }).success).toBe(true);
  });

  it('rejects an unknown key rather than dropping it (CLAUDE.md §5.6)', () => {
    const result = schema.safeParse({ gstin: 'x', not_a_field: 'value' });
    expect(result.success).toBe(false);
  });

  it('rejects a write to a deactivated field while keeping its data elsewhere', () => {
    expect(schema.safeParse({ gstin: 'x', legacy_code: 'L1' }).success).toBe(false);
  });

  it('enforces required fields', () => {
    expect(schema.safeParse({ nickname: 'Priya' }).success).toBe(false);
  });

  it('refuses a prototype-pollution shaped key', () => {
    expect(schema.safeParse({ gstin: 'x', __proto__: { admin: true } }).success).toBe(false);
  });
});

describe('buildCustomFieldsPatchSchema', () => {
  const schema = buildCustomFieldsPatchSchema(definitions);

  it('allows a partial update that omits a required field', () => {
    expect(schema.safeParse({ nickname: 'Priya' }).success).toBe(true);
  });

  it('still rejects unknown keys', () => {
    expect(schema.safeParse({ not_a_field: 1 }).success).toBe(false);
  });

  it('still rejects an invalid value for a field that is present', () => {
    expect(schema.safeParse({ nickname: 123 }).success).toBe(false);
  });
});

describe('metadata helpers', () => {
  it('orders active fields by position', () => {
    expect(activeFields(definitions).map((d) => d.key)).toEqual(['gstin', 'nickname', 'notes']);
  });

  it('excludes long_text from the sortable whitelist', () => {
    expect(sortableFieldKeys(definitions)).toEqual(['gstin', 'nickname']);
  });

  it('allows filtering on every active field', () => {
    expect(filterableFieldKeys(definitions)).toEqual(['gstin', 'nickname', 'notes']);
  });

  it('never lists a deactivated field as sortable or filterable', () => {
    expect(sortableFieldKeys(definitions)).not.toContain('legacy_code');
    expect(filterableFieldKeys(definitions)).not.toContain('legacy_code');
  });
});
