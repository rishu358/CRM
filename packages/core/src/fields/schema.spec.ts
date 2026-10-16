import { describe, expect, it } from 'vitest';
import { buildFieldSchema, buildFieldValueSchema } from './schema.js';
import type { FieldDefinition, FieldType } from './types.js';

function field(type: FieldType, overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    key: 'sample',
    label: 'Sample',
    type,
    required: false,
    isSystem: false,
    isActive: true,
    position: 1,
    ...overrides,
  };
}

const ok = (type: FieldType, value: unknown, overrides?: Partial<FieldDefinition>) =>
  buildFieldValueSchema(field(type, overrides)).safeParse(value).success;

describe('text', () => {
  it('trims and bounds length', () => {
    const schema = buildFieldValueSchema(field('text', { validation: { maxLength: 5 } }));
    expect(schema.parse('  hi  ')).toBe('hi');
    expect(schema.safeParse('toolong').success).toBe(false);
  });

  it('anchors a tenant-supplied pattern so it cannot match a substring', () => {
    const schema = buildFieldValueSchema(field('text', { validation: { pattern: '[A-Z]{3}' } }));
    expect(schema.safeParse('ABC').success).toBe(true);
    expect(schema.safeParse('xABCx').success).toBe(false);
  });
});

describe('email', () => {
  it('lowercases so it matches the citext column', () => {
    expect(buildFieldValueSchema(field('email')).parse('Priya@Example.COM')).toBe(
      'priya@example.com',
    );
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['not-an-email', '@example.com', 'a@b', '']) {
      expect(ok('email', bad)).toBe(false);
    }
  });
});

describe('phone', () => {
  it('requires E.164', () => {
    expect(ok('phone', '+919876543210')).toBe(true);
    expect(ok('phone', '+14155552671')).toBe(true);
  });

  it('rejects local formats and separators', () => {
    for (const bad of ['9876543210', '+91 98765 43210', '+0123456', '98765-43210', '+']) {
      expect(ok('phone', bad)).toBe(false);
    }
  });
});

describe('url', () => {
  it('accepts http and https', () => {
    expect(ok('url', 'https://example.com/path')).toBe(true);
    expect(ok('url', 'http://example.com')).toBe(true);
  });

  it('rejects javascript and data URLs that would become XSS when rendered', () => {
    expect(ok('url', 'javascript:alert(1)')).toBe(false);
    expect(ok('url', 'data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(ok('url', 'file:///etc/passwd')).toBe(false);
  });
});

describe('date and datetime', () => {
  it('accepts a real calendar date and rejects an impossible one', () => {
    expect(ok('date', '2026-02-28')).toBe(true);
    expect(ok('date', '2026-02-30')).toBe(false);
    expect(ok('date', '2026-2-8')).toBe(false);
  });

  it('requires an offset on datetime so the instant is unambiguous', () => {
    expect(ok('datetime', '2026-06-15T12:00:00Z')).toBe(true);
    expect(ok('datetime', '2026-06-15T12:00:00+05:30')).toBe(true);
    expect(ok('datetime', '2026-06-15T12:00:00')).toBe(false);
  });
});

describe('number and percent', () => {
  it('rejects non-finite values', () => {
    expect(ok('number', Number.POSITIVE_INFINITY)).toBe(false);
    expect(ok('number', Number.NaN)).toBe(false);
  });

  it('applies min and max', () => {
    const def = field('number', { validation: { min: '10', max: '20' } });
    const schema = buildFieldValueSchema(def);
    expect(schema.safeParse(15).success).toBe(true);
    expect(schema.safeParse(9).success).toBe(false);
    expect(schema.safeParse(21).success).toBe(false);
  });

  it('defaults percent to 0-100', () => {
    expect(ok('percent', 50)).toBe(true);
    expect(ok('percent', -1)).toBe(false);
    expect(ok('percent', 101)).toBe(false);
  });
});

describe('currency', () => {
  it('takes minor units as a string so large amounts stay exact', () => {
    expect(ok('currency', { amount_minor: '900719925474099300', currency: 'INR' })).toBe(true);
  });

  it('rejects a numeric amount, which JSON would round', () => {
    expect(ok('currency', { amount_minor: 150075, currency: 'INR' })).toBe(false);
  });

  it('rejects a decimal amount and an unknown currency code', () => {
    expect(ok('currency', { amount_minor: '1500.75', currency: 'INR' })).toBe(false);
    expect(ok('currency', { amount_minor: '150075', currency: 'XX' })).toBe(false);
  });

  it('rejects extra keys', () => {
    expect(ok('currency', { amount_minor: '1', currency: 'INR', rate: 1 })).toBe(false);
  });

  it('honours an allowed-currency restriction', () => {
    const overrides = { validation: { allowedCurrencies: ['INR', 'USD'] } };
    expect(ok('currency', { amount_minor: '1', currency: 'INR' }, overrides)).toBe(true);
    expect(ok('currency', { amount_minor: '1', currency: 'EUR' }, overrides)).toBe(false);
  });
});

describe('picklist', () => {
  const options = [
    { value: 'referral', label: 'Referral' },
    { value: 'website', label: 'Website' },
    { value: 'retired', label: 'Retired', isActive: false },
  ];

  it('accepts an active option and rejects anything else', () => {
    expect(ok('picklist', 'referral', { options })).toBe(true);
    expect(ok('picklist', 'walk_in', { options })).toBe(false);
  });

  it('stops offering a deactivated option', () => {
    expect(ok('picklist', 'retired', { options })).toBe(false);
  });

  it('accepts nothing when no options are defined', () => {
    expect(ok('picklist', 'anything', { options: [] })).toBe(false);
  });
});

describe('multi_picklist', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];

  it('accepts a set of active options', () => {
    expect(ok('multi_picklist', ['a', 'b'], { options })).toBe(true);
    expect(ok('multi_picklist', [], { options })).toBe(true);
  });

  it('rejects duplicates and unknown values', () => {
    expect(ok('multi_picklist', ['a', 'a'], { options })).toBe(false);
    expect(ok('multi_picklist', ['a', 'z'], { options })).toBe(false);
  });
});

describe('user_lookup', () => {
  it('validates shape only, never access', () => {
    expect(ok('user_lookup', '018f8c4e-0000-7000-8000-000000000000')).toBe(true);
    expect(ok('user_lookup', 'not-a-uuid')).toBe(false);
  });
});

describe('required vs optional', () => {
  it('a required field rejects null and undefined', () => {
    const schema = buildFieldSchema(field('text', { required: true }));
    expect(schema.safeParse('value').success).toBe(true);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  it('an optional field accepts null as an explicit clear', () => {
    const schema = buildFieldSchema(field('text', { required: false }));
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});
