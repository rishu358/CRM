import { describe, expect, it } from 'vitest';
import {
  applyPermissionPatch,
  canonicalPermissionState,
  diffPermissionState,
  type PermissionState,
} from './patch.js';

const base: PermissionState = {
  grants: [
    { objectType: 'contact', action: 'read', scope: 'all' },
    { objectType: 'contact', action: 'export', scope: 'own' },
  ],
  fieldRules: [{ objectType: 'contact', fieldKey: 'phone', access: 'read' }],
};

describe('applyPermissionPatch', () => {
  it('changes, adds and removes cells, leaving the rest alone', () => {
    const next = applyPermissionPatch(base, {
      grants: [
        { objectType: 'contact', action: 'read', scope: 'team' },
        { objectType: 'contact', action: 'export', scope: null },
        { objectType: 'deal', action: 'read', scope: 'own' },
      ],
      fieldRules: [{ objectType: 'contact', fieldKey: 'phone', access: null }],
    });

    expect(next.grants).toEqual(
      expect.arrayContaining([
        { objectType: 'contact', action: 'read', scope: 'team' },
        { objectType: 'deal', action: 'read', scope: 'own' },
      ]),
    );
    expect(next.grants).toHaveLength(2);
    expect(next.fieldRules).toEqual([]);
  });

  it('does not mutate its input', () => {
    const copy = JSON.stringify(base);
    applyPermissionPatch(base, {
      grants: [{ objectType: 'contact', action: 'read', scope: null }],
      fieldRules: [],
    });
    expect(JSON.stringify(base)).toBe(copy);
  });

  it('lets the last word on a cell win', () => {
    const next = applyPermissionPatch(base, {
      grants: [
        { objectType: 'contact', action: 'read', scope: 'own' },
        { objectType: 'contact', action: 'read', scope: 'team' },
      ],
      fieldRules: [],
    });
    expect(next.grants.find((g) => g.action === 'read')?.scope).toBe('team');
  });
});

describe('diffPermissionState', () => {
  it('reports exactly the cells that moved, in audit-entry form', () => {
    const next = applyPermissionPatch(base, {
      grants: [
        { objectType: 'contact', action: 'read', scope: 'team' },
        { objectType: 'contact', action: 'export', scope: null },
      ],
      fieldRules: [{ objectType: 'contact', fieldKey: 'phone', access: 'hidden' }],
    });

    expect(diffPermissionState(base, next)).toEqual({
      'grant:contact.read': { old: 'all', new: 'team' },
      'grant:contact.export': { old: 'own' },
      'field:contact.phone': { old: 'read', new: 'hidden' },
    });
  });

  it('is empty when nothing changed', () => {
    expect(diffPermissionState(base, applyPermissionPatch(base, { grants: [], fieldRules: [] }))).toEqual(
      {},
    );
  });
});

describe('canonicalPermissionState', () => {
  it('is the same whatever order the cells were read in', () => {
    const reversed: PermissionState = {
      grants: [...base.grants].reverse(),
      fieldRules: [...base.fieldRules].reverse(),
    };
    expect(canonicalPermissionState(reversed)).toBe(canonicalPermissionState(base));
  });

  it('differs when a cell does', () => {
    const next = applyPermissionPatch(base, {
      grants: [{ objectType: 'contact', action: 'read', scope: 'team' }],
      fieldRules: [],
    });
    expect(canonicalPermissionState(next)).not.toBe(canonicalPermissionState(base));
  });
});
