import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../fields/types.js';
import { newId } from '../ids/index.js';
import { makeActor } from '../permissions/testing.js';
import type { FieldPermissionRow, RolePermissionRow } from '../permissions/types.js';
import { importTargets, validateMapping, exportableFields } from './targets.js';

const roleId = newId();

const grant = (objectType: string): RolePermissionRow[] =>
  ['read', 'create', 'update', 'import', 'export'].map(
    (action) => ({ roleId, objectType, action, scope: 'all' }) as RolePermissionRow,
  );

const fieldRule = (fieldKey: string, access: 'hidden' | 'read' | 'write'): FieldPermissionRow => ({
  roleId,
  objectType: 'contact',
  fieldKey,
  access,
});

function field(
  key: string,
  type: FieldDefinition['type'],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    key,
    label: key,
    type,
    required: false,
    isSystem: false,
    isActive: true,
    position: 10,
    ...extra,
  };
}

const contactFields: FieldDefinition[] = [
  field('first_name', 'text', { isSystem: true }),
  field('last_name', 'text', { isSystem: true, required: true }),
  field('email', 'email', { isSystem: true }),
  field('phone', 'phone', { isSystem: true }),
  field('owner_id', 'user_lookup', { isSystem: true }),
  field('region', 'text'),
  field('retired', 'text', { isActive: false }),
];

const actor = (fieldPermissions: FieldPermissionRow[] = []) =>
  makeActor({ rolePermissions: grant('contact'), fieldPermissions });

/** May also read accounts, so the account link is on offer. */
const linker = () => makeActor({ rolePermissions: [...grant('contact'), ...grant('account')] });

describe('importTargets: metadata-driven, allowlisted, write-permission-filtered', () => {
  it('offers system allowlist fields and custom fields, then the owner and account links to someone who may reassign', () => {
    const keys = importTargets(linker(), 'contact', contactFields).map((target) => target.key);
    expect(keys).toEqual([
      'first_name',
      'last_name',
      'email',
      'phone',
      'region',
      'owner_id',
      'account_id',
    ]);
  });

  it('never offers the owner to an `own`-scope importer, whatever the metadata says', () => {
    const rep = makeActor({
      rolePermissions: ['read', 'create', 'update', 'import'].map(
        (action) => ({ roleId, objectType: 'contact', action, scope: 'own' }) as RolePermissionRow,
      ),
      fieldPermissions: [],
    });
    const keys = importTargets(rep, 'contact', contactFields).map((target) => target.key);
    expect(keys).not.toContain('owner_id');
  });

  it('offers the owner to a `team`-scope importer, and the account link only with permission to read accounts', () => {
    const grants = (objectType: string, scope: 'own' | 'team' | 'all', actions: string[]) =>
      actions.map((action) => ({ roleId, objectType, action, scope }) as RolePermissionRow);
    const noAccounts = makeActor({
      rolePermissions: grants('contact', 'team', ['read', 'create', 'update', 'import']),
      fieldPermissions: [],
    });
    expect(importTargets(noAccounts, 'contact', contactFields).map((t) => t.key)).toEqual(
      expect.arrayContaining(['owner_id']),
    );
    expect(importTargets(noAccounts, 'contact', contactFields).map((t) => t.key)).not.toContain(
      'account_id',
    );

    const withAccounts = makeActor({
      rolePermissions: [
        ...grants('contact', 'team', ['read', 'create', 'update', 'import']),
        ...grants('account', 'own', ['read']),
      ],
      fieldPermissions: [],
    });
    expect(importTargets(withAccounts, 'contact', contactFields).map((t) => t.key)).toContain(
      'account_id',
    );
  });

  it('offers the account link for contacts only', () => {
    const accountFields: FieldDefinition[] = [field('name', 'text', { isSystem: true })];
    const keys = importTargets(
      makeActor({ rolePermissions: [...grant('account'), ...grant('contact')] }),
      'account',
      accountFields,
    ).map((target) => target.key);
    expect(keys).toContain('owner_id');
    expect(keys).not.toContain('account_id');
  });

  it('refuses the owner column when a field rule makes the owner unwritable', () => {
    const keys = importTargets(
      actor([fieldRule('owner_id', 'read')]),
      'contact',
      contactFields,
    ).map((target) => target.key);
    expect(keys).not.toContain('owner_id');
  });

  it('offers a custom field the moment it exists in metadata', () => {
    const extended = [...contactFields, field('renewal_date', 'date')];
    const keys = importTargets(actor(), 'contact', extended).map((target) => target.key);
    expect(keys).toContain('renewal_date');
  });

  it('does not offer a deactivated field', () => {
    const keys = importTargets(actor(), 'contact', contactFields).map((target) => target.key);
    expect(keys).not.toContain('retired');
  });

  it('does not offer a system key that is not on the allowlist, even if metadata lists it', () => {
    const sneaky = [...contactFields, field('version', 'number', { isSystem: true })];
    const keys = importTargets(actor(), 'contact', sneaky).map((target) => target.key);
    expect(keys).not.toContain('version');
  });

  it('does not offer a field the actor may read but not write', () => {
    const keys = importTargets(actor([fieldRule('email', 'read')]), 'contact', contactFields).map(
      (target) => target.key,
    );
    expect(keys).not.toContain('email');
  });

  it('does not offer a hidden field', () => {
    const keys = importTargets(
      actor([fieldRule('region', 'hidden')]),
      'contact',
      contactFields,
    ).map((target) => target.key);
    expect(keys).not.toContain('region');
  });
});

describe('validateMapping', () => {
  const base = { columnCount: 5, duplicateMode: 'create' as const, matchField: null };
  const goodMapping = [
    { column: 0, field: 'last_name' },
    { column: 1, field: 'email' },
  ];

  it('accepts a good mapping', () => {
    expect(validateMapping(actor(), 'contact', contactFields, goodMapping, base)).toEqual([]);
  });

  it('accepts a column onto owner_id and account_id for someone who may reassign', () => {
    const issues = validateMapping(
      linker(),
      'contact',
      contactFields,
      [...goodMapping, { column: 2, field: 'owner_id' }, { column: 3, field: 'account_id' }],
      base,
    );
    expect(issues).toEqual([]);
  });

  it('refuses to map a column onto owner_id for an `own`-scope importer, exactly as an unknown field', () => {
    const rep = makeActor({
      rolePermissions: ['read', 'create', 'update', 'import'].map(
        (action) => ({ roleId, objectType: 'contact', action, scope: 'own' }) as RolePermissionRow,
      ),
      fieldPermissions: [],
    });
    const issues = validateMapping(
      rep,
      'contact',
      contactFields,
      [...goodMapping, { column: 2, field: 'owner_id' }],
      base,
    );
    expect(issues.map((issue) => issue.message)).toContain('Cannot import into owner_id');
  });

  it.each(['tenant_id', 'version', 'id', 'created_by', 'deleted_at'])(
    'refuses to map a column onto %s',
    (key) => {
      const issues = validateMapping(
        actor(),
        'contact',
        contactFields,
        [...goodMapping, { column: 2, field: key }],
        base,
      );
      expect(issues.some((issue) => issue.message.includes(key))).toBe(true);
    },
  );

  it('reports a field the actor cannot write exactly as one that does not exist', () => {
    const readOnly = actor([fieldRule('region', 'read')]);
    const hidden = actor([fieldRule('region', 'hidden')]);
    const missing = actor();
    const attempt = (who: ReturnType<typeof actor>, key: string) =>
      validateMapping(
        who,
        'contact',
        contactFields,
        [...goodMapping, { column: 2, field: key }],
        base,
      )
        .map((issue) => issue.message)
        .join('|')
        .replace(key, '<field>');

    expect(attempt(readOnly, 'region')).toBe(attempt(missing, 'no_such_field'));
    expect(attempt(hidden, 'region')).toBe(attempt(missing, 'no_such_field'));
  });

  it('requires required fields to be mapped', () => {
    const issues = validateMapping(
      actor(),
      'contact',
      contactFields,
      [{ column: 1, field: 'email' }],
      base,
    );
    expect(issues.map((issue) => issue.message)).toContain(
      'last_name is required and is not mapped',
    );
  });

  it('says so when the actor cannot write a required field at all', () => {
    const issues = validateMapping(
      actor([fieldRule('last_name', 'read')]),
      'contact',
      contactFields,
      [{ column: 1, field: 'email' }],
      base,
    );
    expect(issues.map((issue) => issue.message).join('|')).toContain('you do not have permission');
  });

  it('rejects a column outside the file, a duplicate column and a duplicate field', () => {
    const issues = validateMapping(
      actor(),
      'contact',
      contactFields,
      [
        { column: 0, field: 'last_name' },
        { column: 0, field: 'email' },
        { column: 9, field: 'phone' },
        { column: 3, field: 'last_name' },
      ],
      base,
    );
    const messages = issues.map((issue) => issue.message);
    expect(messages).toContain('A column can be mapped to only one field');
    expect(messages).toContain('That column is not in the file');
    expect(messages).toContain('A field can be filled from only one column');
  });

  it('requires a mapped match field unless duplicates are simply created', () => {
    const skip = { columnCount: 5, duplicateMode: 'skip' as const };
    expect(
      validateMapping(actor(), 'contact', contactFields, goodMapping, {
        ...skip,
        matchField: null,
      }),
    ).not.toEqual([]);
    expect(
      validateMapping(actor(), 'contact', contactFields, goodMapping, {
        ...skip,
        matchField: 'phone',
      }),
    ).not.toEqual([]); // phone is a valid match field but is not mapped
    expect(
      validateMapping(actor(), 'contact', contactFields, goodMapping, {
        ...skip,
        matchField: 'last_name',
      }),
    ).not.toEqual([]); // not an allowed match field
    expect(
      validateMapping(actor(), 'contact', contactFields, goodMapping, {
        ...skip,
        matchField: 'email',
      }),
    ).toEqual([]);
  });
});

describe('exportableFields', () => {
  it('is active metadata the actor may read, with nothing hardcoded', () => {
    const keys = exportableFields(
      actor([fieldRule('phone', 'hidden')]),
      'contact',
      contactFields,
    ).map((entry) => entry.key);
    expect(keys).toEqual(['first_name', 'last_name', 'email', 'owner_id', 'region']);
  });
});
