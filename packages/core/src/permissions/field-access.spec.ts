import { describe, expect, it } from 'vitest';
import { FieldNotWritableError } from '../errors/index.js';
import { newId, type Uuid } from '../ids/index.js';
import type { Action, Scope } from '../objects/index.js';
import {
  assertWritableFields,
  canReadField,
  canWriteField,
  fieldAccess,
  readableFieldKeys,
  stripHiddenFields,
  stripHiddenFieldsFromAll,
  writableFieldKeys,
} from './field-access.js';
import { makeActor } from './testing.js';
import type { FieldPermissionRow, RolePermissionRow } from './types.js';

const REP = newId();
const MANAGER = newId();

function grant(roleId: Uuid, action: Action, scope: Scope = 'all'): RolePermissionRow {
  return { roleId, objectType: 'contact', action, scope };
}

function fieldRule(
  roleId: Uuid,
  fieldKey: string,
  access: 'hidden' | 'read' | 'write',
): FieldPermissionRow {
  return { roleId, objectType: 'contact', fieldKey, access };
}

describe('defaults derive from the object-level grant', () => {
  it('gives write access to every field when the role can update the object', () => {
    const actor = makeActor({ rolePermissions: [grant(REP, 'read'), grant(REP, 'update')] });
    expect(fieldAccess(actor, 'contact', 'email')).toBe('write');
  });

  it('gives read access only, when the role can read but not update', () => {
    const actor = makeActor({ rolePermissions: [grant(REP, 'read')] });
    expect(fieldAccess(actor, 'contact', 'email')).toBe('read');
    expect(canWriteField(actor, 'contact', 'email')).toBe(false);
  });

  it('hides every field when the role cannot read the object at all', () => {
    const actor = makeActor({ rolePermissions: [grant(REP, 'create')] });
    expect(fieldAccess(actor, 'contact', 'email')).toBe('hidden');
  });

  it('hides every field for an actor with no roles', () => {
    expect(fieldAccess(makeActor({}), 'contact', 'email')).toBe('hidden');
  });
});

describe('field rules narrow but never widen', () => {
  it('a hidden rule removes a field the role could otherwise write', () => {
    const actor = makeActor({
      rolePermissions: [grant(REP, 'read'), grant(REP, 'update')],
      fieldPermissions: [fieldRule(REP, 'annual_revenue_minor', 'hidden')],
    });
    expect(fieldAccess(actor, 'contact', 'annual_revenue_minor')).toBe('hidden');
    expect(fieldAccess(actor, 'contact', 'email')).toBe('write');
  });

  it('a read rule downgrades a writable field', () => {
    const actor = makeActor({
      rolePermissions: [grant(REP, 'read'), grant(REP, 'update')],
      fieldPermissions: [fieldRule(REP, 'lead_source', 'read')],
    });
    expect(fieldAccess(actor, 'contact', 'lead_source')).toBe('read');
  });

  it('a write rule cannot grant write on an object the role can only read', () => {
    // Otherwise field configuration would become a way around object permissions.
    const actor = makeActor({
      rolePermissions: [grant(REP, 'read')],
      fieldPermissions: [fieldRule(REP, 'email', 'write')],
    });
    expect(fieldAccess(actor, 'contact', 'email')).toBe('read');
  });

  it('a write rule cannot grant access on an object the role cannot read', () => {
    const actor = makeActor({
      rolePermissions: [],
      fieldPermissions: [fieldRule(REP, 'email', 'write')],
    });
    expect(fieldAccess(actor, 'contact', 'email')).toBe('hidden');
  });
});

describe('access unions across roles, matching can()', () => {
  it('a second role can restore a field the first role hides', () => {
    const actor = makeActor({
      rolePermissions: [
        grant(REP, 'read'),
        grant(REP, 'update'),
        grant(MANAGER, 'read'),
        grant(MANAGER, 'update'),
      ],
      fieldPermissions: [fieldRule(REP, 'annual_revenue_minor', 'hidden')],
    });
    expect(fieldAccess(actor, 'contact', 'annual_revenue_minor')).toBe('write');
  });

  it('conflicting rules inside one role resolve to the more restrictive', () => {
    const actor = makeActor({
      rolePermissions: [grant(REP, 'read'), grant(REP, 'update')],
      fieldPermissions: [fieldRule(REP, 'email', 'write'), fieldRule(REP, 'email', 'hidden')],
    });
    expect(fieldAccess(actor, 'contact', 'email')).toBe('hidden');
  });
});

describe('stripHiddenFields (CLAUDE.md §5.4)', () => {
  const actor = makeActor({
    rolePermissions: [grant(REP, 'read'), grant(REP, 'update')],
    fieldPermissions: [fieldRule(REP, 'annual_revenue_minor', 'hidden')],
  });

  const record = {
    id: 'c1',
    email: 'priya@example.com',
    annual_revenue_minor: 500000000n,
    lead_source: 'referral',
  };

  it('removes the hidden key entirely rather than nulling it', () => {
    // A null would still confirm the field exists and is populated.
    const visible = stripHiddenFields(actor, 'contact', record);
    expect('annual_revenue_minor' in visible).toBe(false);
    expect(visible.email).toBe('priya@example.com');
  });

  it('does not mutate the input record', () => {
    stripHiddenFields(actor, 'contact', record);
    expect(record.annual_revenue_minor).toBe(500000000n);
  });

  it('strips every row of a list, not just the first', () => {
    const rows = stripHiddenFieldsFromAll(actor, 'contact', [record, record, record]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect('annual_revenue_minor' in row).toBe(false);
    }
  });

  it('returns nothing at all for an actor who cannot read the object', () => {
    expect(stripHiddenFields(makeActor({}), 'contact', record)).toEqual({});
  });
});

describe('assertWritableFields (CLAUDE.md §5.4)', () => {
  const actor = makeActor({
    rolePermissions: [grant(REP, 'read'), grant(REP, 'update')],
    fieldPermissions: [
      fieldRule(REP, 'annual_revenue_minor', 'hidden'),
      fieldRule(REP, 'lead_source', 'read'),
    ],
  });

  it('accepts a write to a writable field', () => {
    expect(() => assertWritableFields(actor, 'contact', ['email'])).not.toThrow();
  });

  it('rejects a write to a hidden field instead of silently dropping it', () => {
    expect(() => assertWritableFields(actor, 'contact', ['annual_revenue_minor'])).toThrow(
      FieldNotWritableError,
    );
  });

  it('rejects a write to a read-only field', () => {
    expect(() => assertWritableFields(actor, 'contact', ['lead_source'])).toThrow(
      FieldNotWritableError,
    );
  });

  it('rejects the whole write when any one field is not writable', () => {
    expect(() => assertWritableFields(actor, 'contact', ['email', 'annual_revenue_minor'])).toThrow(
      FieldNotWritableError,
    );
  });

  it('reports hidden and read-only fields identically', () => {
    // Distinguishing them would reveal which concealed fields exist.
    const hiddenError = (() => {
      try {
        assertWritableFields(actor, 'contact', ['annual_revenue_minor']);
      } catch (error) {
        return error as FieldNotWritableError;
      }
      throw new Error('expected a throw');
    })();
    const readOnlyError = (() => {
      try {
        assertWritableFields(actor, 'contact', ['lead_source']);
      } catch (error) {
        return error as FieldNotWritableError;
      }
      throw new Error('expected a throw');
    })();

    expect(hiddenError.code).toBe(readOnlyError.code);
    expect(hiddenError.message).toBe(readOnlyError.message);
    expect(hiddenError.details[0]?.message).toBe(readOnlyError.details[0]?.message);
  });

  it('names every rejected field so the caller can fix the request', () => {
    try {
      assertWritableFields(actor, 'contact', ['annual_revenue_minor', 'lead_source']);
      throw new Error('expected a throw');
    } catch (error) {
      const paths = (error as FieldNotWritableError).details.map((d) => d.path);
      expect(paths).toEqual(['annual_revenue_minor', 'lead_source']);
    }
  });
});

describe('field key helpers for building UI', () => {
  const actor = makeActor({
    rolePermissions: [grant(REP, 'read'), grant(REP, 'update')],
    fieldPermissions: [
      fieldRule(REP, 'annual_revenue_minor', 'hidden'),
      fieldRule(REP, 'lead_source', 'read'),
    ],
  });
  const all = ['email', 'lead_source', 'annual_revenue_minor'];

  it('lists readable keys', () => {
    expect(readableFieldKeys(actor, 'contact', all)).toEqual(['email', 'lead_source']);
    expect(canReadField(actor, 'contact', 'lead_source')).toBe(true);
  });

  it('lists writable keys', () => {
    expect(writableFieldKeys(actor, 'contact', all)).toEqual(['email']);
  });
});
