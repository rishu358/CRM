import { MERGE_FIELDS } from '@crm/core';
import { describe, expect, it } from 'vitest';
import { STANDARD_FIELD_KEYS as ACCOUNT_KEYS } from '../accounts/accounts.serializer.js';
import { STANDARD_FIELD_KEYS as CONTACT_KEYS } from '../contacts/contacts.serializer.js';

/**
 * The fields a merge lets a person choose between are listed in `@crm/core`, and each module's
 * serializer lists the fields it reads and writes. A field added to a module and not to the merge would
 * be silently left out of the choice; a field in the merge and not in the module would be a write nobody
 * checks. Both fail here instead (ADR-0064). The owner is the one deliberate difference: handing a
 * record to somebody else is a reassignment, which has its own rules.
 */
describe('the fields a merge can choose are the fields the module has', () => {
  const asMap = (fields: readonly { apiKey: string; fieldKey: string }[]) =>
    Object.fromEntries(fields.map((field) => [field.apiKey, field.fieldKey]));
  const withoutOwner = (keys: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(keys).filter(([apiKey]) => apiKey !== 'ownerId'));

  it('contact', () => {
    expect(asMap(MERGE_FIELDS.contact)).toEqual(withoutOwner(CONTACT_KEYS));
  });

  it('account', () => {
    expect(asMap(MERGE_FIELDS.account)).toEqual(withoutOwner(ACCOUNT_KEYS));
  });
});
