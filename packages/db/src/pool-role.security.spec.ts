import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { assertConnectedRoles } from '@crm/core';
import { readPoolRole } from './client.js';

/**
 * The startup guard against a runtime role that can walk through row-level security
 * (CLAUDE.md §5.1, ADR-0042).
 *
 * `readPoolRole` is what the API and the worker ask the database before they listen. These run it
 * against a real Postgres, as the real roles, and as a role built to look like a managed
 * provider's administrative one: not a superuser, but with BYPASSRLS. That is the case that
 * matters, because it is the one a provider hands you as its first connection string and the one
 * a name check alone would miss if the role were renamed.
 */
const ADMIN_LIKE = 'crm_test_admin_like';

let superuser: pg.Pool;
const pools: pg.Pool[] = [];

function poolFor(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 1 });
  pools.push(pool);
  return pool;
}

function asRole(superuserUrl: string, role: string, password: string): string {
  const url = new URL(superuserUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 1 });
  await superuser.query(`drop role if exists ${ADMIN_LIKE}`);
  await superuser.query(
    `create role ${ADMIN_LIKE} login password 'admin_like_pw' nosuperuser createrole bypassrls`,
  );
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await superuser.query(`drop role if exists ${ADMIN_LIKE}`);
  await superuser.end();
});

describe('the role a connection really runs as', () => {
  it.each(['app', 'auth', 'worker', 'erasure', 'migrator'] as const)(
    'accepts the %s role the bootstrap builds',
    async (name) => {
      const role = await readPoolRole(poolFor(inject('dbUrls')[name]));
      expect(role).toEqual({ name: `crm_${name}`, superuser: false, bypassRls: false });
      expect(() => assertConnectedRoles({ DATABASE_URL: role })).not.toThrow();
    },
  );

  it('sees a superuser for what it is', async () => {
    const role = await readPoolRole(poolFor(inject('dbUrls').superuser));
    expect(role.superuser).toBe(true);
    expect(() => assertConnectedRoles({ DATABASE_URL: role })).toThrow(/is a superuser/);
  });

  it('sees BYPASSRLS on a role that is not a superuser, whatever it is called', async () => {
    const pool = poolFor(asRole(inject('dbUrls').superuser, ADMIN_LIKE, 'admin_like_pw'));
    const role = await readPoolRole(pool);
    expect(role).toEqual({ name: ADMIN_LIKE, superuser: false, bypassRls: true });
    expect(() => assertConnectedRoles({ DATABASE_URL: role })).toThrow(
      /DATABASE_URL connects as role "crm_test_admin_like", which has BYPASSRLS/,
    );
  });
});
