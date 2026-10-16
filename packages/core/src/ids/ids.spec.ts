import { describe, expect, it } from 'vitest';
import { assertUuid, isUuid, isUuidV7, newId, timestampFromUuidV7 } from './index.js';

describe('newId', () => {
  it('mints valid v7 UUIDs', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(isUuidV7(id)).toBe(true);
  });

  it('is time-sortable, which keyset pagination depends on (ADR-0012)', async () => {
    const first = newId();
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = newId();
    expect(first < second).toBe(true);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});

describe('isUuidV7', () => {
  it('rejects a v4 UUID', () => {
    // Enumeration-safe but not time-sortable: must not pass as one of ours.
    expect(isUuidV7('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')).toBe(false);
  });

  it('rejects non-UUID input without throwing', () => {
    for (const value of ['', 'not-a-uuid', null, undefined, 42, {}, []]) {
      expect(isUuidV7(value)).toBe(false);
      expect(isUuid(value)).toBe(false);
    }
  });

  it('rejects SQL-injection shaped input', () => {
    expect(isUuid("' OR 1=1 --")).toBe(false);
  });
});

describe('timestampFromUuidV7', () => {
  it('recovers the creation instant within a second', () => {
    const before = Date.now();
    const id = newId();
    const extracted = timestampFromUuidV7(id);
    expect(extracted).not.toBeNull();
    expect(extracted!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(extracted!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('returns null for a non-v7 UUID', () => {
    expect(timestampFromUuidV7('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')).toBeNull();
  });
});

describe('assertUuid', () => {
  it('returns the value when valid', () => {
    const id = newId();
    expect(assertUuid(id)).toBe(id);
  });

  it('throws with the label when invalid', () => {
    expect(() => assertUuid('nope', 'contactId')).toThrow(/contactId/);
  });
});
