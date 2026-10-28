import { describe, expect, it } from 'vitest';
import type { FieldDefinitionView } from './fields';
import { defaultChoices, loserFields, mergeRows, plainValue, type MergeRecord } from './merge';

/**
 * The field table of the merge dialog (ADR-0064): what is offered, what is selected to start with, and
 * what is sent. The server holds the real rules; this is only what the person is shown and what they ask for.
 */

const definition = (key: string, label: string, isSystem: boolean): FieldDefinitionView =>
  ({ key, label, isSystem }) as FieldDefinitionView;

const DEFINITIONS = [
  definition('first_name', 'First name', true),
  definition('last_name', 'Last name', true),
  definition('email', 'Email', true),
  definition('phone', 'Phone', true),
  definition('region', 'Region', false),
];

const record = (id: string, fields: Record<string, unknown>): MergeRecord => ({
  id,
  version: 1,
  ...fields,
});

describe('which fields are offered', () => {
  it('offers only what came back for one record or the other, standard fields then custom, with the company’s labels', () => {
    const rows = mergeRows(
      'contact',
      record('a', { lastName: 'Sharma', email: 'a@x.example', customFields: { region: 'North' } }),
      record('b', {
        lastName: 'Sharma',
        phone: '+919876500001',
        customFields: { region: 'South' },
      }),
      DEFINITIONS,
    );
    expect(rows.map((row) => [row.key, row.label])).toEqual([
      ['lastName', 'Last name'],
      ['email', 'Email'],
      ['phone', 'Phone'],
      ['region', 'Region'],
    ]);
  });

  it('does not offer a field the API did not return for either record (one this person may not read)', () => {
    const rows = mergeRows(
      'contact',
      record('a', { lastName: 'Sharma' }),
      record('b', { lastName: 'Sharma' }),
      DEFINITIONS,
    );
    expect(rows.map((row) => row.key)).toEqual(['lastName']);
  });

  it('never offers the owner, which a merge cannot change', () => {
    const rows = mergeRows(
      'contact',
      record('a', { lastName: 'A', ownerId: 'u1' }),
      record('b', { lastName: 'B', ownerId: 'u2' }),
      DEFINITIONS,
    );
    expect(rows.map((row) => row.key)).not.toContain('ownerId');
  });

  it('marks fields that say the same thing, so there is nothing to choose', () => {
    const rows = mergeRows(
      'account',
      record('a', { name: 'Initech', billingAddress: { city: 'Pune' } }),
      record('b', { name: 'Initech', billingAddress: { city: 'Mumbai' } }),
      [definition('name', 'Name', true), definition('billing_address', 'Billing address', true)],
    );
    expect(rows.find((row) => row.key === 'name')?.same).toBe(true);
    expect(rows.find((row) => row.key === 'billingAddress')?.same).toBe(false);
  });
});

describe('what is selected to start with, and what is sent', () => {
  const rows = mergeRows(
    'contact',
    record('a', { lastName: 'Sharma', email: 'a@x.example', phone: null }),
    record('b', { lastName: 'Sharma-Iyer', email: 'b@x.example', phone: '+919876500001' }),
    DEFINITIONS,
  );

  it('keeps the master’s value, except where the master has nothing and the other has something', () => {
    expect(defaultChoices(rows)).toEqual({ lastName: 'master', email: 'master', phone: 'loser' });
  });

  it('sends only the fields where the other record wins, and never one that says the same', () => {
    expect(loserFields({ lastName: 'loser', email: 'master', phone: 'loser' }, rows)).toEqual({
      lastName: 'loser',
      phone: 'loser',
    });
    const same = mergeRows(
      'contact',
      record('a', { lastName: 'X' }),
      record('b', { lastName: 'X' }),
      DEFINITIONS,
    );
    expect(loserFields({ lastName: 'loser' }, same)).toEqual({});
  });
});

describe('how a value is shown', () => {
  it('shows text, numbers and empty values plainly, and an address as one line', () => {
    expect(plainValue('Pune')).toBe('Pune');
    expect(plainValue(42)).toBe('42');
    expect(plainValue(null)).toBe('');
    expect(plainValue('')).toBe('');
    expect(plainValue({ line1: '1 MG Road', city: 'Pune', state: null })).toBe('1 MG Road, Pune');
  });
});
