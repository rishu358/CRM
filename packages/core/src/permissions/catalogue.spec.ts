import { describe, expect, it } from 'vitest';
import { newId } from '../ids/index.js';
import { OBJECT_TYPES } from '../objects/index.js';
import { GRANT_CATALOGUE, grantsBeyond, isGrantable } from './catalogue.js';
import { makeActor } from './testing.js';

describe('the grant catalogue', () => {
  it('covers every object type the engine can be asked about', () => {
    const covered = GRANT_CATALOGUE.map((entry) => entry.objectType).sort();
    expect(covered).toEqual([...OBJECT_TYPES].sort());
  });

  it('refuses switches that are wired to nothing', () => {
    expect(isGrantable('deal', 'import', 'all')).toBe(true);
    // Original dates on import are one switch, workspace-wide, not scoped to anyone's records.
    expect(isGrantable('import_history', 'create', 'all')).toBe(true);
    expect(isGrantable('import_history', 'create', 'own')).toBe(false);
    expect(isGrantable('import_history', 'read', 'all')).toBe(false);
    expect(isGrantable('activity', 'export', 'all')).toBe(false);
    expect(isGrantable('invitation', 'read', 'own')).toBe(false);
    expect(isGrantable('role', 'update', 'team')).toBe(false);
  });

  it('allows the ordinary ones', () => {
    expect(isGrantable('contact', 'export', 'own')).toBe(true);
    expect(isGrantable('deal', 'update', 'team')).toBe(true);
    expect(isGrantable('role', 'update', 'all')).toBe(true);
  });
});

describe('no escalation', () => {
  const roleId = newId();
  const actor = makeActor({
    rolePermissions: [
      { roleId, objectType: 'contact', action: 'read', scope: 'team' },
      { roleId, objectType: 'contact', action: 'update', scope: 'own' },
    ],
  });

  it('flags a grant wider than the actor holds, or one they hold nothing of', () => {
    const beyond = grantsBeyond(actor, [
      { objectType: 'contact', action: 'read', scope: 'all' },
      { objectType: 'contact', action: 'update', scope: 'team' },
      { objectType: 'contact', action: 'delete', scope: 'own' },
    ]);
    expect(beyond.map((g) => `${g.action}:${g.scope}`)).toEqual([
      'read:all',
      'update:team',
      'delete:own',
    ]);
  });

  it('lets an actor hand out what they hold, or less', () => {
    expect(
      grantsBeyond(actor, [
        { objectType: 'contact', action: 'read', scope: 'team' },
        { objectType: 'contact', action: 'read', scope: 'own' },
        { objectType: 'contact', action: 'update', scope: 'own' },
      ]),
    ).toEqual([]);
  });
});
