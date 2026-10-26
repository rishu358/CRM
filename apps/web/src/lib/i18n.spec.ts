import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  actionVerb,
  directionLabel,
  objectLabel,
  objectSingularLabel,
  scopeLabel,
} from './access-labels';
import { en, t, tPlural } from './i18n';

/**
 * The translation layer's one structural promise: a key that has a `.one` form
 * has an `.other`, and the two say the same thing about the same things.
 *
 * `tPlural` picks between them at run time by a count, so a missing half is an
 * English sentence that is simply absent on screen at the one count that needs
 * it — the sort of defect that survives review because it only shows at "1".
 */
describe('plural pairs', () => {
  const keys = Object.keys(en);
  const bases = keys.filter((key) => key.endsWith('.one')).map((key) => key.slice(0, -4));

  it('has at least the pairs the access screens use', () => {
    expect(bases).toEqual(
      expect.arrayContaining(['effect.people', 'whoCanSee.can', 'reassign.willMove']),
    );
  });

  it.each(bases)('%s has both forms, and the singular uses nothing the plural lacks', (base) => {
    const one = (en as Record<string, string>)[`${base}.one`];
    const other = (en as Record<string, string>)[`${base}.other`];
    expect(other, `${base}.other is missing`).toBeDefined();

    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)]
        .map((match) => match[1])
        .filter((name) => name !== 'count')
        .sort();
    // "1 record" may leave a placeholder out ("{formatted} records" needs it);
    // what it may not do is use one the plural form never receives.
    const available = new Set(placeholders(other ?? ''));
    for (const name of placeholders(one ?? '')) {
      expect(available.has(name), `{${name}} is in ${base}.one but not ${base}.other`).toBe(true);
    }
  });

  it('never has an `.other` without a `.one`', () => {
    for (const key of keys.filter((candidate) => candidate.endsWith('.other'))) {
      expect(keys, `${key} has no .one`).toContain(`${key.slice(0, -6)}.one`);
    }
  });
});

describe('tPlural', () => {
  it('picks the form by count and groups large numbers the way the viewer reads them', () => {
    expect(tPlural('teams.memberCount', 1)).toBe('1 person');
    expect(tPlural('teams.memberCount', 0)).toBe('0 people');
    expect(tPlural('teams.memberCount', 2)).toBe('2 people');
    // lakh grouping: 1,24,000, not 124,000
    expect(tPlural('teams.memberCount', 124000)).toBe('1,24,000 people');
  });

  it('interpolates extra values alongside the count', () => {
    expect(
      tPlural('effect.line.lose.counted', 3, {
        verb: 'see',
        max: '1,240',
        objects: 'contacts',
        total: '3,410',
      }),
    ).toBe('3 people can no longer see up to 1,240 contacts each (3,410 in all).');
    expect(
      tPlural('effect.line.lose.counted', 1, {
        verb: 'see',
        max: '1',
        objects: 'contact',
        total: '1',
      }),
    ).toBe('1 person can no longer see up to 1 contact.');
  });

  it('has every variant the effect summary can ask for', () => {
    for (const direction of ['lose', 'gain']) {
      for (const shape of ['counted', 'plain']) {
        for (const form of ['one', 'other']) {
          expect(Object.keys(en), `effect.line.${direction}.${shape}.${form}`).toContain(
            `effect.line.${direction}.${shape}.${form}`,
          );
        }
      }
    }
  });
});

describe('the words for permissions', () => {
  it('translates the codes the API sends', () => {
    expect(objectLabel('contact')).toBe('Contacts');
    expect(objectSingularLabel('contact')).toBe('contact');
    expect(actionLabel('update')).toBe('Edit');
    expect(actionVerb('update')).toBe('edit');
    expect(directionLabel('narrowed')).toBe('Narrowed');
    expect(scopeLabel('team')).toBe('Team’s records');
  });

  it('says "No access" for no grant, never a blank', () => {
    expect(scopeLabel(null)).toBe(t('access.scope.none'));
    expect(scopeLabel(null)).not.toBe('');
  });

  it('shows an unknown code rather than hiding it', () => {
    // A new object type or action reaching the screen before it has words must
    // be visible and recognisably wrong, not silently absent.
    expect(objectLabel('widget')).toBe('widget');
    expect(actionLabel('teleport')).toBe('teleport');
    expect(directionLabel('sideways')).toBe('sideways');
  });
});
