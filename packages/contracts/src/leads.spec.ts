import { describe, expect, it } from 'vitest';
import {
  duplicateCheckSchema,
  leadConvertSchema,
  leadCreateSchema,
  leadUpdateSchema,
} from './leads.js';

describe('leadCreateSchema', () => {
  it('requires a surname and lowercases the email', () => {
    expect(leadCreateSchema.safeParse({}).success).toBe(false);
    const parsed = leadCreateSchema.parse({ lastName: 'Desai', email: 'Anita@Desai.Example' });
    expect(parsed.email).toBe('anita@desai.example');
  });

  it('rejects an unknown key, including every way of naming a tenant or a conversion', () => {
    for (const extra of [
      { tenantId: '01a1443a-0000-7000-8000-000000000000' },
      { convertedAt: '2026-01-01T00:00:00Z' },
      { convertedContactId: '01a1443a-0000-7000-8000-000000000000' },
      { score: 90 },
    ]) {
      expect(leadCreateSchema.safeParse({ lastName: 'X', ...extra }).success).toBe(false);
    }
  });

  it('refuses to be told a lead is converted', () => {
    expect(leadCreateSchema.safeParse({ lastName: 'X', status: 'converted' }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ lastName: 'X', status: 'qualified' }).success).toBe(true);
  });

  it('requires an E.164 phone number', () => {
    expect(leadCreateSchema.safeParse({ lastName: 'X', phone: '98765' }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ lastName: 'X', phone: '+919876543210' }).success).toBe(
      true,
    );
  });
});

describe('leadUpdateSchema', () => {
  it('requires the version, so an edit is never last-write-wins', () => {
    expect(leadUpdateSchema.safeParse({ lastName: 'X' }).success).toBe(false);
    expect(leadUpdateSchema.safeParse({ lastName: 'X', version: 1 }).success).toBe(true);
  });

  it('cannot move a lead to converted', () => {
    expect(leadUpdateSchema.safeParse({ status: 'converted', version: 1 }).success).toBe(false);
  });
});

describe('duplicateCheckSchema', () => {
  it('accepts any subset, including none', () => {
    expect(duplicateCheckSchema.safeParse({}).success).toBe(true);
    expect(duplicateCheckSchema.safeParse({ company: 'Acme' }).success).toBe(true);
  });

  it('lowercases the email so it compares like with like', () => {
    expect(duplicateCheckSchema.parse({ email: 'A@B.Example' }).email).toBe('a@b.example');
  });
});

describe('leadConvertSchema', () => {
  it('needs only a version, and does not acknowledge duplicates unless told to', () => {
    const parsed = leadConvertSchema.parse({ version: 3 });
    expect(parsed.acknowledgeDuplicates).toBe(false);
    expect(parsed.contact).toBeUndefined();
    expect(parsed.deal).toBeUndefined();
  });

  it('requires the id of the record being linked to', () => {
    expect(leadConvertSchema.safeParse({ version: 1, contact: { mode: 'link' } }).success).toBe(
      false,
    );
    expect(
      leadConvertSchema.safeParse({
        version: 1,
        contact: { mode: 'link', contactId: '01a1443a-0000-7000-8000-000000000000' },
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown mode, and a stray key inside a choice', () => {
    expect(leadConvertSchema.safeParse({ version: 1, account: { mode: 'merge' } }).success).toBe(
      false,
    );
    expect(
      leadConvertSchema.safeParse({ version: 1, contact: { mode: 'create', accountId: 'x' } })
        .success,
    ).toBe(false);
  });

  it('allows no company to be modelled as "none"', () => {
    expect(leadConvertSchema.safeParse({ version: 1, account: { mode: 'none' } }).success).toBe(
      true,
    );
  });
});
