import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_TYPES,
  FIELD_KEY_PATTERN,
  MAX_PICKLIST_OPTIONS,
  OPTION_VALUE_PATTERN,
  isCustomFieldType,
  isCustomizableObject,
  resolveOptions,
  slugify,
  uniqueSlug,
  validateFieldValidation,
} from './index.js';

describe('which types and objects can be customised', () => {
  it('offers every field type except user_lookup', () => {
    expect(CUSTOM_FIELD_TYPES).toContain('picklist');
    expect(CUSTOM_FIELD_TYPES).toContain('currency');
    expect(CUSTOM_FIELD_TYPES).not.toContain('user_lookup');
    expect(isCustomFieldType('user_lookup')).toBe(false);
    expect(isCustomFieldType('text')).toBe(true);
    expect(isCustomFieldType('formula')).toBe(false);
  });

  it('customises the four record objects and not activities, roles or anything else', () => {
    for (const object of ['account', 'contact', 'lead', 'deal']) {
      expect(isCustomizableObject(object)).toBe(true);
    }
    for (const object of ['activity', 'role', 'tenant_settings', '', undefined, 'Contact']) {
      expect(isCustomizableObject(object)).toBe(false);
    }
  });
});

describe('slugify', () => {
  it.each([
    ['GSTIN number', 'gstin_number'],
    ['  Preferred contact time  ', 'preferred_contact_time'],
    ['Café & Bar — #1', 'cafe_bar_1'],
    ['2nd address', 'f_2nd_address'],
    ['***', 'field'],
    ['', 'field'],
    ['ALL CAPS', 'all_caps'],
    ['नमस्ते', 'field'],
  ])('%j becomes %j', (label, expected) => {
    expect(slugify(label)).toBe(expected);
  });

  it('always produces a valid field key, whatever it is given', () => {
    for (const label of ['x', '9', '_', 'a'.repeat(500), '🚀🚀', "Robert'); DROP TABLE", '__proto__', 'constructor']) {
      const key = slugify(label);
      expect(FIELD_KEY_PATTERN.test(key), label).toBe(true);
      expect(key.length).toBeLessThanOrEqual(40);
    }
  });

  it('leaves room for a collision suffix inside the 63 characters the database allows', () => {
    const taken = new Set<string>();
    const base = slugify('a'.repeat(500));
    for (let n = 0; n < 150; n += 1) taken.add(uniqueSlug(base, taken));
    for (const key of taken) expect(FIELD_KEY_PATTERN.test(key)).toBe(true);
    expect(taken.size).toBe(150);
  });
});

describe('uniqueSlug', () => {
  it('returns the base when free, and counts up from 2 when not', () => {
    expect(uniqueSlug('region', new Set())).toBe('region');
    expect(uniqueSlug('region', new Set(['region']))).toBe('region_2');
    expect(uniqueSlug('region', new Set(['region', 'region_2', 'region_3']))).toBe('region_4');
  });
});

describe('resolveOptions', () => {
  const existing = [
    { value: 'hot', label: 'Hot', isActive: true },
    { value: 'warm', label: 'Warm', isActive: true },
  ];

  it('gives each new option a value made from its label, unique and valid', () => {
    const result = resolveOptions(undefined, [
      { label: 'Walk-in' },
      { label: 'Walk in!' },
      { label: 'Trade fair' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.map((o) => o.value)).toEqual(['walk_in', 'walk_in_2', 'trade_fair']);
    for (const option of result.options) expect(OPTION_VALUE_PATTERN.test(option.value)).toBe(true);
    expect(result.options.every((o) => o.isActive === true)).toBe(true);
  });

  it('keeps an existing value through a relabel, a reorder and a deactivation', () => {
    const result = resolveOptions(existing, [
      { value: 'warm', label: 'Lukewarm', isActive: false },
      { value: 'hot', label: 'Hot' },
      { label: 'Cold' },
    ]);
    expect(result).toEqual({
      ok: true,
      options: [
        { value: 'warm', label: 'Lukewarm', isActive: false },
        { value: 'hot', label: 'Hot', isActive: true },
        { value: 'cold', label: 'Cold', isActive: true },
      ],
    });
  });

  it('refuses to drop an option that has been offered', () => {
    const result = resolveOptions(existing, [{ value: 'hot', label: 'Hot' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(/deactivate/);
  });

  it('does not let a client invent a value for an option that does not exist', () => {
    const result = resolveOptions(existing, [
      { value: 'hot', label: 'Hot' },
      { value: 'warm', label: 'Warm' },
      { value: 'sneaky', label: 'Sneaky' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('refuses the same existing option listed twice', () => {
    const result = resolveOptions(existing, [
      { value: 'hot', label: 'Hot' },
      { value: 'hot', label: 'Hotter' },
      { value: 'warm', label: 'Warm' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('refuses labels that differ only by case or spaces at the edges', () => {
    const result = resolveOptions(undefined, [{ label: 'North' }, { label: ' north ' }]);
    expect(result.ok).toBe(false);
  });

  it('needs at least one option, at least one of them active, and no more than the maximum', () => {
    expect(resolveOptions(undefined, []).ok).toBe(false);
    expect(resolveOptions(undefined, [{ label: 'Only', isActive: false }]).ok).toBe(false);
    const many = Array.from({ length: MAX_PICKLIST_OPTIONS + 1 }, (_, n) => ({ label: `Option ${n}` }));
    expect(resolveOptions(undefined, many).ok).toBe(false);
    const fits = Array.from({ length: MAX_PICKLIST_OPTIONS }, (_, n) => ({ label: `Option ${n}` }));
    expect(resolveOptions(undefined, fits).ok).toBe(true);
  });

  it('bounds a label, and trims it', () => {
    expect(resolveOptions(undefined, [{ label: '   ' }]).ok).toBe(false);
    expect(resolveOptions(undefined, [{ label: 'x'.repeat(81) }]).ok).toBe(false);
    const result = resolveOptions(undefined, [{ label: '  Spaced  ' }]);
    expect(result.ok && result.options[0]?.label).toBe('Spaced');
  });

  it('does not let a new option take a value an old, retired one still holds', () => {
    const withRetired = [
      { value: 'hot', label: 'Hot', isActive: false },
      { value: 'warm', label: 'Warm', isActive: true },
    ];
    const result = resolveOptions(withRetired, [
      { value: 'hot', label: 'Hot', isActive: false },
      { value: 'warm', label: 'Warm' },
      { label: 'Hot!' },
    ]);
    expect(result.ok && result.options[2]?.value).toBe('hot_2');
  });
});

describe('validateFieldValidation', () => {
  it('accepts nothing for a type that has no limits', () => {
    expect(validateFieldValidation('boolean', undefined)).toEqual([]);
    expect(validateFieldValidation('boolean', { maxLength: 5 })).not.toEqual([]);
    expect(validateFieldValidation('picklist', { min: '1' })).not.toEqual([]);
    expect(validateFieldValidation('phone', { maxLength: 5 })).not.toEqual([]);
  });

  it('never accepts a pattern, for any type: a pattern is a program the server runs', () => {
    for (const type of ['text', 'long_text', 'email', 'phone', 'url'] as const) {
      const issues = validateFieldValidation(type, { pattern: '(a+)+$' });
      expect(issues.map((i) => i.path)).toEqual(['validation.pattern']);
    }
  });

  it('bounds text lengths by what the engine allows for that type', () => {
    expect(validateFieldValidation('text', { minLength: 1, maxLength: 255 })).toEqual([]);
    expect(validateFieldValidation('text', { maxLength: 256 })).not.toEqual([]);
    expect(validateFieldValidation('long_text', { maxLength: 32_000 })).toEqual([]);
    expect(validateFieldValidation('long_text', { maxLength: 32_001 })).not.toEqual([]);
    expect(validateFieldValidation('text', { minLength: 10, maxLength: 5 })).not.toEqual([]);
    expect(validateFieldValidation('text', { minLength: -1 })).not.toEqual([]);
    expect(validateFieldValidation('text', { maxLength: 1.5 })).not.toEqual([]);
  });

  it('takes decimal strings for number and percent limits, minimum not above maximum', () => {
    expect(validateFieldValidation('number', { min: '0', max: '12.5' })).toEqual([]);
    expect(validateFieldValidation('number', { min: '-3', max: '-1' })).toEqual([]);
    expect(validateFieldValidation('number', { min: 'abc' })).not.toEqual([]);
    expect(validateFieldValidation('number', { min: '1e9' })).not.toEqual([]);
    expect(validateFieldValidation('number', { min: '10', max: '2' })).not.toEqual([]);
    expect(validateFieldValidation('percent', { min: '0', max: '200' })).toEqual([]);
    expect(validateFieldValidation('number', { maxLength: 5 })).not.toEqual([]);
  });

  it('takes a short list of distinct currency codes for a currency field', () => {
    expect(validateFieldValidation('currency', { allowedCurrencies: ['INR', 'USD'] })).toEqual([]);
    expect(validateFieldValidation('currency', { allowedCurrencies: ['INR', 'inr'] })).not.toEqual([]);
    expect(validateFieldValidation('currency', { allowedCurrencies: ['RUPEE'] })).not.toEqual([]);
    expect(validateFieldValidation('currency', { min: '1' })).not.toEqual([]);
  });
});
