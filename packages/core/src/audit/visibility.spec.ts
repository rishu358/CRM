import { describe, expect, it } from 'vitest';
import { newId } from '../ids/index.js';
import { makeActor } from '../permissions/testing.js';
import type { Action, ObjectType, Scope } from '../objects/index.js';
import { QUERY_COLUMNS } from '../import-export/query-columns.js';
import {
  canViewAuditObjectType,
  EVENT_METADATA_KEY_LIST,
  toFieldKey,
  visibleAuditChanges,
} from './visibility.js';
import { diffChanges } from './index.js';

/**
 * MVP_SPEC M3: "A field marked hidden for a role never appears in API
 * responses, exports, search results **or audit diffs** shown to that role."
 *
 * These are the audit-diff half of that sentence, at the level where the rule
 * actually lives. The API and worker suites then prove the rule is reached from
 * both the viewer and the export file.
 */

const roleId = newId();

function actorWith(
  grants: readonly { objectType: string; action: Action; scope: Scope }[],
  fields: readonly {
    objectType: string;
    fieldKey: string;
    access: 'hidden' | 'read' | 'write';
  }[] = [],
) {
  return makeActor({
    rolePermissions: grants.map((grant) => ({
      roleId,
      objectType: grant.objectType as ObjectType,
      action: grant.action,
      scope: grant.scope,
    })),
    fieldPermissions: fields.map((field) => ({
      roleId,
      objectType: field.objectType as ObjectType,
      fieldKey: field.fieldKey,
      access: field.access,
    })),
  });
}

const readsContacts = [{ objectType: 'contact', action: 'read' as Action, scope: 'all' as Scope }];

describe('toFieldKey', () => {
  it('converts a diff key to the field key permissions are written against', () => {
    expect(toFieldKey('lastName')).toBe('last_name');
    expect(toFieldKey('ownerId')).toBe('owner_id');
    expect(toFieldKey('annualRevenueMinor')).toBe('annual_revenue_minor');
    // Already snake_case, or a single word: unchanged.
    expect(toFieldKey('email')).toBe('email');
    expect(toFieldKey('lead_source')).toBe('lead_source');
  });
});

describe('visibleAuditChanges', () => {
  it('keeps a field the reader may read', () => {
    const actor = actorWith(readsContacts);
    const result = visibleAuditChanges(actor, 'contact', {
      lastName: { old: 'Rao', new: 'Rao-Patel' },
    });

    expect(result.changes).toEqual({ lastName: { old: 'Rao', new: 'Rao-Patel' } });
    expect(result.withheldFields).toBe(0);
  });

  it('removes a field hidden from the reader, values and all', () => {
    const actor = actorWith(readsContacts, [
      { objectType: 'contact', fieldKey: 'email', access: 'hidden' },
    ]);

    const result = visibleAuditChanges(actor, 'contact', {
      lastName: { old: 'Rao', new: 'Rao-Patel' },
      email: { old: 'old@example.com', new: 'new@example.com' },
    });

    expect(Object.keys(result.changes)).toEqual(['lastName']);
    expect(JSON.stringify(result.changes)).not.toContain('example.com');
    expect(result.withheldFields).toBe(1);
  });

  it('splits customFields so a hidden custom field cannot ride along', () => {
    const actor = actorWith(readsContacts, [
      { objectType: 'contact', fieldKey: 'pan_number', access: 'hidden' },
    ]);

    // This is the shape `diffChanges` actually produces: one entry holding the
    // whole jsonb object, visible and hidden custom fields together.
    const changes = diffChanges(
      { customFields: { segment: 'SMB', pan_number: 'ABCDE1234F' } },
      { customFields: { segment: 'Enterprise', pan_number: 'ZZZZZ9999Z' } },
    );
    expect(Object.keys(changes)).toEqual(['customFields']);

    const result = visibleAuditChanges(actor, 'contact', changes);

    expect(result.changes).toEqual({
      'customFields.segment': { old: 'SMB', new: 'Enterprise' },
    });
    expect(JSON.stringify(result.changes)).not.toContain('ABCDE1234F');
    expect(JSON.stringify(result.changes)).not.toContain('ZZZZZ9999Z');
    expect(result.withheldFields).toBe(1);
  });

  it('does not invent entries for custom fields that did not change', () => {
    const actor = actorWith(readsContacts);
    const changes = diffChanges(
      { customFields: { segment: 'SMB', region: 'West' } },
      { customFields: { segment: 'Enterprise', region: 'West' } },
    );

    const result = visibleAuditChanges(actor, 'contact', changes);
    expect(Object.keys(result.changes)).toEqual(['customFields.segment']);
  });

  it('withholds everything when the reader cannot read the object at all', () => {
    // Holds the audit capability, has no grant on deals: reading history must
    // not restore access the role was deliberately not given.
    const actor = actorWith([{ objectType: 'audit_log', action: 'read', scope: 'all' }]);

    const result = visibleAuditChanges(actor, 'deal', {
      name: { old: 'Q3 renewal', new: 'Q4 renewal' },
      amountMinor: { old: '100000', new: '250000' },
    });

    expect(result.changes).toEqual({});
    expect(result.withheldFields).toBe(2);
    expect(canViewAuditObjectType(actor, 'deal')).toBe(false);
  });

  it('shows platform object diffs to anyone who may read the log', () => {
    // An invitation, a session or an export job has no field_definitions row,
    // so there is no field permission to apply. Running the field filter over
    // them would hide every diff rather than none.
    const actor = actorWith([{ objectType: 'audit_log', action: 'read', scope: 'all' }]);

    const result = visibleAuditChanges(actor, 'invitation', {
      email: { new: 'invitee@example.com' },
    });

    expect(result.changes).toEqual({ email: { new: 'invitee@example.com' } });
    expect(result.withheldFields).toBe(0);
  });

  it('keeps metadata about the event itself', () => {
    const actor = actorWith(readsContacts, [
      { objectType: 'contact', fieldKey: 'email', access: 'hidden' },
    ]);

    const result = visibleAuditChanges(actor, 'contact', {
      importJobId: { new: 'job-1' },
      rowCount: { new: 42 },
    });

    expect(result.changes).toEqual({ importJobId: { new: 'job-1' }, rowCount: { new: 42 } });
  });

  it('treats a null diff as nothing withheld', () => {
    const actor = actorWith(readsContacts);
    expect(visibleAuditChanges(actor, 'contact', null)).toEqual({
      changes: {},
      withheldFields: 0,
    });
  });

  it('keeps only one half of an entry when the diff had only one', () => {
    const actor = actorWith(readsContacts);
    const result = visibleAuditChanges(actor, 'contact', { lastName: { new: 'Rao' } });
    expect(result.changes).toEqual({ lastName: { new: 'Rao' } });
  });

  it('is union across roles, like every other permission', () => {
    const otherRole = newId();
    const actor = makeActor({
      rolePermissions: [
        { roleId, objectType: 'contact', action: 'read', scope: 'all' },
        { roleId: otherRole, objectType: 'contact', action: 'read', scope: 'all' },
      ],
      fieldPermissions: [
        { roleId, objectType: 'contact', fieldKey: 'email', access: 'hidden' },
        { roleId: otherRole, objectType: 'contact', fieldKey: 'email', access: 'read' },
      ],
    });

    const result = visibleAuditChanges(actor, 'contact', {
      email: { old: 'a@example.com', new: 'b@example.com' },
    });

    expect(Object.keys(result.changes)).toEqual(['email']);
  });
});

describe('the event-metadata list cannot shadow a real field', () => {
  it('shares no key with any object’s standard columns', () => {
    // Metadata keys are passed through before the field check, so a key that is
    // also a field name would hand that field's values to a reader who may not
    // read it. This is the guard: a new column named `reason` or `format` fails
    // here rather than leaking quietly.
    const fieldKeys = new Set(
      Object.values(QUERY_COLUMNS).flatMap((columns) => Object.keys(columns)),
    );

    const collisions = EVENT_METADATA_KEY_LIST.filter((key) => fieldKeys.has(toFieldKey(key)));

    expect(
      collisions,
      'An audit-diff metadata key is also a field name. Rename the metadata key, ' +
        'or the diff will show that field to readers who may not see it.',
    ).toEqual([]);
  });
});
