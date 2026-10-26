import { describe, expect, it } from 'vitest';
import {
  ADMINISTRATIVE_OBJECT_TYPES,
  BUSINESS_OBJECT_TYPES,
  OBJECT_TYPES,
  SOFT_DELETABLE_OBJECT_TYPES,
  isAdministrativeObjectType,
} from './index.js';

/**
 * Every object type is either a record or a capability — and the registry says
 * which.
 *
 * `ADMINISTRATIVE_OBJECT_TYPES` exists so a caller can ask "is this a record?"
 * without listing the exceptions, which only works while the list is complete.
 * It went stale exactly once, and instructively: M3 added `role`, `team` and
 * `membership` to `OBJECT_TYPES` on one branch while M11 added this list on
 * another, so each side was internally consistent and the gap appeared only in
 * the merge — the one moment nobody is reading either file.
 *
 * So the list is not maintained by hand any more; it is asserted to be the
 * complement of the record types. A new object type fails this test until
 * somebody decides which kind it is.
 */
describe('the object-type registry', () => {
  const records = new Set<string>([...BUSINESS_OBJECT_TYPES, ...SOFT_DELETABLE_OBJECT_TYPES]);

  it('classifies every object type as either a record or a capability', () => {
    const unclassified = OBJECT_TYPES.filter(
      (type) => !records.has(type) && !isAdministrativeObjectType(type),
    );
    expect(unclassified, `unclassified object types: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('never calls a record a capability', () => {
    const both = OBJECT_TYPES.filter(
      (type) => records.has(type) && isAdministrativeObjectType(type),
    );
    expect(both, `classified as both: ${both.join(', ')}`).toEqual([]);
  });

  it('lists exactly the non-record types, in registry order', () => {
    expect([...ADMINISTRATIVE_OBJECT_TYPES].sort()).toEqual(
      OBJECT_TYPES.filter((type) => !records.has(type))
        .slice()
        .sort(),
    );
  });
});
