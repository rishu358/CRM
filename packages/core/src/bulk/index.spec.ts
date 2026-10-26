import { describe, expect, it } from 'vitest';
import {
  BULK_EDITABLE_FIELDS,
  BULK_MAX_RECORDS,
  bulkEditableField,
  isValidTagName,
  normalizeTagName,
  TAG_NAME_MAX,
} from './index.js';

describe('what a bulk edit may name', () => {
  it('never offers an identifier, the owner, a deal amount or pipeline', () => {
    const forbidden = [
      'first_name',
      'last_name',
      'name',
      'email',
      'phone',
      'whatsapp',
      'gstin',
      'domain',
      'owner_id',
      'amount',
      'pipeline_id',
      'id',
      'version',
      'tenant_id',
      'created_by',
      'deleted_at',
      'converted_at',
      'custom_fields',
    ];
    for (const [objectType, fields] of Object.entries(BULK_EDITABLE_FIELDS)) {
      for (const field of fields) {
        expect(forbidden, `${objectType}.${field.key}`).not.toContain(field.key);
      }
    }
  });

  it('answers only for the object it is asked about', () => {
    expect(bulkEditableField('contact', 'title')?.property).toBe('title');
    expect(bulkEditableField('account', 'title')).toBeUndefined();
    expect(bulkEditableField('deal', 'stage_id')?.property).toBe('stageId');
    expect(bulkEditableField('contact', 'constructor')).toBeUndefined();
  });

  it('caps a call at two hundred records', () => {
    expect(BULK_MAX_RECORDS).toBe(200);
  });
});

describe('tag names', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeTagName('  hot \t  lead ')).toBe('hot lead');
  });

  it('accepts a name of 1 to 50 characters on one line', () => {
    expect(isValidTagName('VIP')).toBe(true);
    expect(isValidTagName('a'.repeat(TAG_NAME_MAX))).toBe(true);
    expect(isValidTagName('')).toBe(false);
    expect(isValidTagName('a'.repeat(TAG_NAME_MAX + 1))).toBe(false);
  });

  it('refuses control characters, which a name collapsed from a paste could still carry', () => {
    expect(isValidTagName('bad\u0000name')).toBe(false);
    expect(isValidTagName('bad\u007fname')).toBe(false);
    expect(isValidTagName('bad\u001bname')).toBe(false);
  });
});
