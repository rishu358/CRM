import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAG_COLORS } from '@crm/core';
import { describe, expect, it } from 'vitest';
import { packageRootFrom } from './package-root.js';

/**
 * The list of tag colours exists twice, in `@crm/core` (what Zod and the screens use) and in the
 * `CHECK` on `tags.color` (what the database holds to it, migration 0025, ADR-0063). A colour added to
 * one and not the other is a value the API accepts and the database refuses, or the reverse, found by a
 * person saving a tag. This keeps the two the same list.
 */
describe('tag colours', () => {
  const sql = readFileSync(
    join(packageRootFrom(import.meta.url), 'migrations', '0025_tags.sql'),
    'utf8',
  );
  const check = /tags_color_chk CHECK \(([\s\S]*?)\);/.exec(sql)?.[1] ?? '';
  const inDatabase = [...check.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);

  it('are the same names in the migration and in core', () => {
    expect([...inDatabase].sort()).toEqual([...TAG_COLORS].sort());
  });
});
