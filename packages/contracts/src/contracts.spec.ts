import { describe, expect, it } from 'vitest';
import { contactCreateSchema, contactUpdateSchema } from './contacts.js';
import { listQuerySchema, parseFilter, parseSort, toFilterList } from './pagination.js';

describe('contactCreateSchema', () => {
  it('accepts a minimal valid contact', () => {
    expect(contactCreateSchema.safeParse({ lastName: 'Sharma' }).success).toBe(true);
  });

  it('requires a last name', () => {
    expect(contactCreateSchema.safeParse({ firstName: 'Anjali' }).success).toBe(false);
    expect(contactCreateSchema.safeParse({ lastName: '   ' }).success).toBe(false);
  });

  it('rejects unknown keys rather than dropping them (CLAUDE.md §5.6)', () => {
    const result = contactCreateSchema.safeParse({ lastName: 'Sharma', isAdmin: true });
    expect(result.success).toBe(false);
  });

  it('refuses a tenantId in the body: it comes from the session (§5.2)', () => {
    const result = contactCreateSchema.safeParse({
      lastName: 'Sharma',
      tenantId: '018f8c4e-0000-7000-8000-000000000000',
    });
    expect(result.success).toBe(false);
  });

  it('requires E.164 phone numbers', () => {
    expect(contactCreateSchema.safeParse({ lastName: 'S', phone: '+919876543210' }).success).toBe(
      true,
    );
    expect(contactCreateSchema.safeParse({ lastName: 'S', phone: '9876543210' }).success).toBe(
      false,
    );
  });
});

describe('contactUpdateSchema', () => {
  it('requires a version so edits cannot be last-write-wins', () => {
    expect(contactUpdateSchema.safeParse({ lastName: 'Sharma' }).success).toBe(false);
    expect(contactUpdateSchema.safeParse({ lastName: 'Sharma', version: 3 }).success).toBe(true);
  });

  it('rejects a zero or negative version', () => {
    expect(contactUpdateSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(contactUpdateSchema.safeParse({ version: -1 }).success).toBe(false);
  });
});

describe('listQuerySchema', () => {
  it('caps limit at 100 (CLAUDE.md §8)', () => {
    expect(listQuerySchema.safeParse({ limit: '100' }).success).toBe(true);
    expect(listQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('defaults limit when omitted', () => {
    const parsed = listQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
  });

  it('offers no offset or page parameter', () => {
    expect(listQuerySchema.safeParse({ offset: '100' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ page: '3' }).success).toBe(false);
  });

  it('rejects a sort key that is not a field-shaped identifier', () => {
    expect(listQuerySchema.safeParse({ sort: '-created_at' }).success).toBe(true);
    expect(listQuerySchema.safeParse({ sort: 'name; drop table contacts' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ sort: 'Name' }).success).toBe(false);
  });
});

describe('parseSort', () => {
  it('reads the leading minus as descending', () => {
    expect(parseSort('created_at')).toEqual({ field: 'created_at', direction: 'asc' });
    expect(parseSort('-created_at')).toEqual({ field: 'created_at', direction: 'desc' });
  });
});

describe('parseFilter', () => {
  it('splits field, operator and value', () => {
    expect(parseFilter('lead_source:eq:referral')).toEqual({
      field: 'lead_source',
      operator: 'eq',
      value: 'referral',
    });
  });

  it('keeps colons that belong to the value', () => {
    expect(parseFilter('created_at:gte:2026-06-15T12:00:00Z')?.value).toBe('2026-06-15T12:00:00Z');
  });

  it('rejects an unknown operator', () => {
    expect(parseFilter('name:drop:x')).toBeNull();
  });

  it('rejects a field name that is not an identifier', () => {
    expect(parseFilter("name'; delete from contacts --:eq:x")).toBeNull();
    expect(parseFilter('Name:eq:x')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseFilter('')).toBeNull();
    expect(parseFilter('noseparator')).toBeNull();
    expect(parseFilter(':eq:x')).toBeNull();
  });
});

describe('toFilterList', () => {
  it('normalises one or many into a list', () => {
    expect(toFilterList(undefined)).toEqual([]);
    expect(toFilterList('a:eq:1')).toEqual(['a:eq:1']);
    expect(toFilterList(['a:eq:1', 'b:eq:2'])).toEqual(['a:eq:1', 'b:eq:2']);
  });
});
