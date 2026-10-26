import { describe, expect, it } from 'vitest';
import {
  displayValue,
  draftFromValue,
  emptyDraft,
  isEmptyDraft,
  safeHref,
  valueFromDraft,
} from './custom-field-values';

const PREFS = { locale: 'en-IN', timeZone: 'Asia/Kolkata' } as const;
const LABELS = { yes: 'Yes', no: 'No' } as const;

const def = (type: string) => ({ type }) as never;

describe('what a stored value looks like in a box, and what comes back', () => {
  it.each([
    ['text', 'Mornings', 'Mornings'],
    ['long_text', 'a\nb', 'a\nb'],
    ['email', 'a@b.co', 'a@b.co'],
    ['phone', '+919876543210', '+919876543210'],
    ['url', 'https://example.com/x', 'https://example.com/x'],
    ['date', '2026-10-05', '2026-10-05'],
    ['picklist', 'north', 'north'],
    ['number', 12.5, 12.5],
    ['number', -3, -3],
    ['percent', 40, 40],
    ['boolean', true, true],
    ['boolean', false, false],
    ['multi_picklist', ['a', 'b'], ['a', 'b']],
  ])('round-trips a %s (%j)', (type, stored, expected) => {
    const draft = draftFromValue(def(type), stored);
    expect(valueFromDraft(def(type), draft)).toEqual({ ok: true, value: expected });
  });

  it('round-trips money through major units without touching floating point', () => {
    const stored = { amount_minor: '9007199254740993', currency: 'INR' };
    const draft = draftFromValue(def('currency'), stored);
    expect(draft).toEqual({ amount: '90071992547409.93', currency: 'INR' });
    expect(valueFromDraft(def('currency'), draft)).toEqual({ ok: true, value: stored });
  });

  it('knows a yen has no decimals and a dinar has three', () => {
    expect(draftFromValue(def('currency'), { amount_minor: '1500', currency: 'JPY' })).toEqual({
      amount: '1500',
      currency: 'JPY',
    });
    expect(valueFromDraft(def('currency'), { amount: '1.5', currency: 'KWD' })).toEqual({
      ok: true,
      value: { amount_minor: '1500', currency: 'KWD' },
    });
    expect(valueFromDraft(def('currency'), { amount: '1.5', currency: 'JPY' }).ok).toBe(false);
  });

  it('round-trips an instant to the minute in the browser’s own zone', () => {
    const stored = '2026-10-05T09:30:00.000Z';
    const draft = draftFromValue(def('datetime'), stored) as string;
    expect(draft).toMatch(/^2026-10-05T\d{2}:\d{2}$/);
    expect(valueFromDraft(def('datetime'), draft)).toEqual({ ok: true, value: stored });
  });
});

describe('an empty box', () => {
  it.each(['text', 'number', 'date', 'boolean', 'picklist', 'currency', 'multi_picklist'])(
    'is null for a %s, which is how the API clears a value',
    (type) => {
      const draft = emptyDraft(def(type));
      expect(isEmptyDraft(def(type), draft)).toBe(true);
      expect(valueFromDraft(def(type), draft)).toEqual({ ok: true, value: null });
    },
  );

  it('is also what a missing or null stored value shows', () => {
    for (const stored of [null, undefined]) {
      expect(draftFromValue(def('text'), stored)).toBe('');
      expect(draftFromValue(def('multi_picklist'), stored)).toEqual([]);
    }
  });

  it('counts only spaces as empty', () => {
    expect(isEmptyDraft(def('text'), '   ')).toBe(true);
    expect(valueFromDraft(def('text'), '  hi  ')).toEqual({ ok: true, value: 'hi' });
  });
});

describe('what is refused with a message beside the box', () => {
  it.each(['abc', '1,000', '1e5', '--1', '1.', '.5', '0x10'])(
    'does not guess at the number %j',
    (typed) => {
      const result = valueFromDraft(def('number'), typed);
      expect(result).toEqual({ ok: false, error: 'customFields.error.number' });
    },
  );

  it('refuses a malformed amount and a malformed instant', () => {
    expect(valueFromDraft(def('currency'), { amount: 'lots', currency: 'INR' })).toEqual({
      ok: false,
      error: 'error.amount',
    });
    expect(valueFromDraft(def('datetime'), 'not a time')).toEqual({
      ok: false,
      error: 'customFields.error.date',
    });
  });
});

describe('displayValue', () => {
  const options = [
    { value: 'north', label: 'North region', isActive: true },
    { value: 'south', label: 'South region', isActive: false },
  ];

  it('shows an option by its label, a retired one included', () => {
    expect(displayValue({ type: 'picklist', options }, 'north', PREFS, LABELS)).toBe(
      'North region',
    );
    expect(displayValue({ type: 'picklist', options }, 'south', PREFS, LABELS)).toBe(
      'South region',
    );
    expect(
      displayValue({ type: 'multi_picklist', options }, ['north', 'south'], PREFS, LABELS),
    ).toBe('North region, South region');
  });

  it('shows a value with no option as it is, rather than hiding it', () => {
    expect(displayValue({ type: 'picklist', options }, 'gone', PREFS, LABELS)).toBe('gone');
  });

  it('formats money, numbers, percentages and booleans for the viewer', () => {
    expect(
      displayValue(
        { type: 'currency' },
        { amount_minor: '123456', currency: 'INR' },
        PREFS,
        LABELS,
      ),
    ).toBe('₹1,234.56');
    expect(displayValue({ type: 'number' }, 1234567.5, PREFS, LABELS)).toBe('12,34,567.5');
    expect(displayValue({ type: 'percent' }, 40, PREFS, LABELS)).toBe('40%');
    expect(displayValue({ type: 'boolean' }, true, PREFS, LABELS)).toBe('Yes');
    expect(displayValue({ type: 'boolean' }, false, PREFS, LABELS)).toBe('No');
  });

  it('shows nothing for nothing, and never throws on a value of the wrong shape', () => {
    expect(displayValue({ type: 'number' }, null, PREFS, LABELS)).toBe('');
    for (const type of ['currency', 'date', 'datetime', 'number', 'multi_picklist', 'boolean']) {
      expect(() => displayValue({ type } as never, { odd: true }, PREFS, LABELS)).not.toThrow();
    }
  });
});

describe('safeHref', () => {
  it('links web addresses and nothing else', () => {
    expect(safeHref('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(safeHref('http://example.com')).toBe('http://example.com/');
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<b>',
      'file:///etc/passwd',
      'mailto:a@b',
      'example.com',
      '',
      null,
      5,
    ]) {
      expect(safeHref(bad), String(bad)).toBeNull();
    }
  });
});
