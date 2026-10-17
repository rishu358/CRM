import { describe, expect, it } from 'vitest';
import { accountCreateSchema, accountUpdateSchema, addressSchema } from './accounts.js';

/**
 * Schema-level rules for accounts.
 *
 * These are the decisions that are specific to a company rather than a person,
 * so they are the ones most likely to be got wrong by copying the contacts
 * contract. The API behaviour built on top of them is covered in
 * `apps/api/src/modules/accounts/accounts.spec.ts`.
 */

describe('accountCreateSchema', () => {
  it('accepts a minimal valid account', () => {
    expect(accountCreateSchema.safeParse({ name: 'Rajesh Gold House' }).success).toBe(true);
  });

  it('requires a name that is more than whitespace', () => {
    expect(accountCreateSchema.safeParse({}).success).toBe(false);
    expect(accountCreateSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects unknown keys rather than dropping them (CLAUDE.md §5.6)', () => {
    expect(accountCreateSchema.safeParse({ name: 'Acme', isAdmin: true }).success).toBe(false);
  });

  it('refuses a tenantId in the body: it comes from the session (§5.2)', () => {
    const result = accountCreateSchema.safeParse({
      name: 'Acme',
      tenantId: '018f8c4e-0000-7000-8000-000000000000',
    });
    expect(result.success).toBe(false);
  });
});

describe('domain', () => {
  it('lower-cases so duplicate detection compares like with like', () => {
    const parsed = accountCreateSchema.parse({ name: 'Acme', domain: 'Acme.Example' });
    expect(parsed.domain).toBe('acme.example');
  });

  it('refuses a URL, which belongs in website', () => {
    for (const domain of [
      'https://acme.example',
      'acme.example/pricing',
      'acme.example:443',
      'acme',
      '-acme.example',
      'acme-.example',
    ]) {
      expect(accountCreateSchema.safeParse({ name: 'Acme', domain }).success, domain).toBe(false);
    }
  });
});

describe('gstin', () => {
  it('accepts a well-formed number and upper-cases it', () => {
    const parsed = accountCreateSchema.parse({ name: 'Acme', gstin: '29abcde1234f1z5' });
    expect(parsed.gstin).toBe('29ABCDE1234F1Z5');
  });

  it('rejects the wrong length or shape', () => {
    for (const gstin of ['29ABCDE1234F1Z', '29ABCDE1234F1Z55', 'ABCDE12345F1Z5', '']) {
      expect(accountCreateSchema.safeParse({ name: 'Acme', gstin }).success, gstin).toBe(false);
    }
  });
});

describe('website', () => {
  it('accepts http and https only', () => {
    expect(
      accountCreateSchema.safeParse({ name: 'Acme', website: 'https://acme.example' }).success,
    ).toBe(true);
    // A javascript: URL rendered as a link on the record page is an XSS vector.
    expect(
      accountCreateSchema.safeParse({ name: 'Acme', website: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      accountCreateSchema.safeParse({ name: 'Acme', website: 'data:text/html,<script>' }).success,
    ).toBe(false);
  });
});

describe('annualRevenue', () => {
  it('takes minor units as a string, never a number', () => {
    const parsed = accountCreateSchema.parse({
      name: 'Acme',
      annualRevenue: { amountMinor: '120000000000', currency: 'inr' },
    });
    expect(parsed.annualRevenue).toEqual({ amountMinor: '120000000000', currency: 'INR' });
  });

  it('refuses a float, a JSON number and a bare amount', () => {
    for (const annualRevenue of [
      { amountMinor: 1200.5, currency: 'INR' },
      { amountMinor: 1200, currency: 'INR' },
      { amountMinor: '1200.50', currency: 'INR' },
      { amountMinor: '1200' },
      { amountMinor: '-1200', currency: 'INR' },
      { amountMinor: '1200', currency: 'RUPEES' },
    ]) {
      expect(
        accountCreateSchema.safeParse({ name: 'Acme', annualRevenue }).success,
        JSON.stringify(annualRevenue),
      ).toBe(false);
    }
  });

  it('survives an amount larger than Number.MAX_SAFE_INTEGER intact', () => {
    const huge = '9007199254740993';
    const parsed = accountCreateSchema.parse({
      name: 'Acme',
      annualRevenue: { amountMinor: huge, currency: 'INR' },
    });
    expect(parsed.annualRevenue?.amountMinor).toBe(huge);
  });
});

describe('addresses', () => {
  it('rejects unknown keys inside the jsonb, which nothing else validates', () => {
    expect(addressSchema.safeParse({ city: 'Chennai' }).success).toBe(true);
    expect(addressSchema.safeParse({ city: 'Chennai', note: 'anything' }).success).toBe(false);
  });

  it('requires a two-letter country code and upper-cases it', () => {
    expect(addressSchema.parse({ country: 'in' }).country).toBe('IN');
    expect(addressSchema.safeParse({ country: 'India' }).success).toBe(false);
  });
});

describe('accountUpdateSchema', () => {
  it('requires a version so edits cannot be last-write-wins', () => {
    expect(accountUpdateSchema.safeParse({ name: 'Acme' }).success).toBe(false);
    expect(accountUpdateSchema.safeParse({ name: 'Acme', version: 3 }).success).toBe(true);
  });

  it('allows clearing a nullable field explicitly', () => {
    const parsed = accountUpdateSchema.parse({ gstin: null, version: 1 });
    expect(parsed.gstin).toBeNull();
  });
});
