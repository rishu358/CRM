import { newId } from '@crm/core';
import { typedPool, type TypedPool } from '@crm/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The Recycle Bin (MVP_SPEC M4, CLAUDE.md §5 and §10).
 *
 * The four mandatory suites, plus the two rules this feature turns on:
 *
 *   - **the Bin does not list records outside the actor's scope.** A rep on
 *     `own` scope must not learn what a colleague deleted — the Bin is a list
 *     of records, and the same constraint applies to it as to any other list.
 *   - **restore re-checks permission at restore time.** It does not inherit the
 *     right from whoever deleted the record.
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;

/**
 * Rows from the superuser pool, named.
 *
 * `typedPool` returns `Record<string, unknown>[]` on purpose — `pg`'s default
 * `any[]` switches the type checker off for everything a test reads back, which
 * is how an assertion ends up checking a column that does not exist. This
 * narrows at the call site instead.
 */
async function rowsOf<T>(text: string, values: readonly unknown[] = []): Promise<T[]> {
  return (await superuser.query(text, values)).rows as T[];
}

let tenantA: string;
let tenantB: string;
let rolesA: ReadonlyMap<string, string>;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };
/** Two users who may delete (and so restore) their **own** contacts, and nobody else's. */
let ownDeleterA: { token: string; userId: string };
let ownDeleterB: { token: string; userId: string };
let adminB: { token: string; userId: string };

async function userWithRole(tenantId: string, roleId: string) {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

/** A contact, created live and then soft-deleted as the API would have. */
async function deletedContact(
  tenantId: string,
  ownerId: string | null,
  lastName = 'Sharma',
): Promise<string> {
  const id = newId();
  await superuser.query(
    `insert into contacts (id, tenant_id, owner_id, last_name, email, deleted_at)
     values ($1, $2, $3, $4, $5, now())`,
    [id, tenantId, ownerId, lastName, `${newId().slice(0, 8)}@example.com`],
  );
  return id;
}

const list = (token: string | undefined, objectType = 'contact', extra = '') =>
  request(harness, {
    method: 'GET',
    url: `/api/v1/recycle-bin?objectType=${objectType}${extra}`,
    token,
  });

const restore = (token: string | undefined, objectType: string, id: string, version = 1) =>
  request(harness, {
    method: 'POST',
    url: `/api/v1/recycle-bin/${objectType}/${id}/restore`,
    token,
    body: { version },
  });

const idsOf = (response: { body: Record<string, unknown> }): string[] =>
  (response.body['data'] as { id: string }[]).map((row) => row.id);

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  superuser = typedPool(rawSuperuser);

  tenantA = (await harness.fixtures.createTenant({ name: 'Bin A' })).tenantId;
  rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Bin B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await userWithRole(tenantA, rolesA.get('Admin')!);
  repA = await userWithRole(tenantA, rolesA.get('Sales Rep')!);
  otherRepA = await userWithRole(tenantA, rolesA.get('Sales Rep')!);
  adminB = await userWithRole(tenantB, rolesB.get('Admin')!);

  // The seeded Sales Rep cannot delete at all, so it cannot exercise *scope* on
  // restore — it would be refused for lacking the grant. This role can delete
  // what it owns and nothing else, which is the case the scope rule is about.
  const ownDeleter = await harness.fixtures.createRole(tenantA, `Own deleter ${newId()}`);
  await harness.fixtures.grant(tenantA, ownDeleter, 'contact', 'read', 'own');
  await harness.fixtures.grant(tenantA, ownDeleter, 'contact', 'delete', 'own');
  ownDeleterA = await userWithRole(tenantA, ownDeleter);
  ownDeleterB = await userWithRole(tenantA, ownDeleter);
});

afterAll(async () => {
  await rawSuperuser.end();
  await harness.close();
});

describe('authentication (CLAUDE.md §10d)', () => {
  it('refuses unauthenticated list and restore', async () => {
    expect((await list(undefined)).status).toBe(401);
    expect((await restore(undefined, 'contact', newId())).status).toBe(401);
  });
});

describe('tenant isolation (CLAUDE.md §10a)', () => {
  it("does not list another tenant's deleted records", async () => {
    const mine = await deletedContact(tenantA, adminA.userId, 'Mine');
    const theirs = await deletedContact(tenantB, adminB.userId, 'Theirs');

    const response = await list(adminA.token, 'contact', '&limit=100');
    expect(response.status).toBe(200);
    expect(idsOf(response)).toContain(mine);
    expect(idsOf(response)).not.toContain(theirs);
    expect(JSON.stringify(response.body)).not.toContain('Theirs');
  });

  it("cannot restore another tenant's record, and says 404 not 403", async () => {
    const theirs = await deletedContact(tenantB, adminB.userId);
    const response = await restore(adminA.token, 'contact', theirs);
    expect(response.status).toBe(404);

    // Byte-identical to a plain miss, so the endpoint is not an existence
    // oracle (CLAUDE.md §5.5).
    const missing = await restore(adminA.token, 'contact', newId());
    expect(missing.status).toBe(404);
    expect((response.body['error'] as { message: string }).message).toBe(
      (missing.body['error'] as { message: string }).message,
    );

    const stillDeleted = await rowsOf<{ deleted_at: Date | null }>(
      'select deleted_at from contacts where id = $1',
      [theirs],
    );
    expect(stillDeleted[0]?.deleted_at).not.toBeNull();
  });
});

describe('record scope (CLAUDE.md §10b)', () => {
  it("a rep on `own` scope does not see a colleague's deleted records", async () => {
    const mine = await deletedContact(tenantA, repA.userId, 'RepOwn');
    const theirs = await deletedContact(tenantA, otherRepA.userId, 'ColleagueOwn');

    const response = await list(repA.token, 'contact', '&limit=100');
    expect(idsOf(response)).toContain(mine);
    expect(idsOf(response)).not.toContain(theirs);
    expect(JSON.stringify(response.body)).not.toContain('ColleagueOwn');
  });

  it("a rep cannot restore a colleague's record", async () => {
    const theirs = await deletedContact(tenantA, ownDeleterB.userId);
    const response = await restore(ownDeleterA.token, 'contact', theirs);
    expect(response.status).toBe(404);
  });

  it('an Admin sees both', async () => {
    const mine = await deletedContact(tenantA, repA.userId, 'AdminSeesA');
    const theirs = await deletedContact(tenantA, otherRepA.userId, 'AdminSeesB');

    const response = await list(adminA.token, 'contact', '&limit=100');
    expect(idsOf(response)).toEqual(expect.arrayContaining([mine, theirs]));
  });
});

describe('a manager on `team` scope (pilot finding F3)', () => {
  /**
   * The default Manager deletes with `team` scope. Restore is the inverse of delete and uses the same
   * rule, so whatever the manager could delete they can put back. Until this was fixed, restore asked
   * `can()` about a record that carried only its owner, which a `team` grant cannot match, so it
   * answered 404 and the record stayed deleted.
   */
  let manager: { token: string; userId: string };
  let teammate: { token: string; userId: string };
  let outsider: { token: string; userId: string };

  beforeAll(async () => {
    manager = await userWithRole(tenantA, rolesA.get('Manager')!);
    teammate = await userWithRole(tenantA, rolesA.get('Sales Rep')!);
    outsider = await userWithRole(tenantA, rolesA.get('Sales Rep')!);
    await harness.fixtures.createTeam(tenantA, `Bin team ${newId()}`, [
      manager.userId,
      teammate.userId,
    ]);
    await harness.fixtures.createTeam(tenantA, `Bin other team ${newId()}`, [outsider.userId]);
  });

  const del = (token: string, path: string) =>
    request(harness, { method: 'DELETE', url: `/api/v1/${path}?version=1`, token });

  it('restores a teammate’s contact, lead, account and deal that the same manager deleted', async () => {
    const pipeline = await harness.fixtures.createPipeline(tenantA, `Bin pipe ${newId()}`, [
      { name: 'Open', stageType: 'open', probability: 10 },
    ]);
    const records: { objectType: string; path: string; id: string }[] = [
      {
        objectType: 'contact',
        path: 'contacts',
        id: await harness.fixtures.createContact(tenantA, { ownerId: teammate.userId }),
      },
      {
        objectType: 'lead',
        path: 'leads',
        id: await harness.fixtures.createLead(tenantA, { ownerId: teammate.userId }),
      },
      {
        objectType: 'account',
        path: 'accounts',
        id: await harness.fixtures.createAccount(tenantA, { ownerId: teammate.userId }),
      },
      {
        objectType: 'deal',
        path: 'deals',
        id: await harness.fixtures.createDeal(tenantA, {
          ownerId: teammate.userId,
          pipelineId: pipeline.pipelineId,
          stageId: pipeline.stageIds[0]!,
        }),
      },
    ];

    for (const record of records) {
      const deleted = await del(manager.token, `${record.path}/${record.id}`);
      expect(deleted.status, `delete ${record.objectType}`).toBeLessThan(300);

      const listed = await list(manager.token, record.objectType, '&limit=100');
      const entry = (listed.body['data'] as { id: string; version: number }[]).find(
        (row) => row.id === record.id,
      );
      expect(entry, `${record.objectType} is in the Bin`).toBeDefined();

      const restored = await restore(manager.token, record.objectType, record.id, entry!.version);
      expect(restored.status, `restore ${record.objectType}`).toBe(200);
      const live = await rowsOf<{ deleted_at: Date | null }>(
        `select deleted_at from ${record.path} where id = $1`,
        [record.id],
      );
      expect(live[0]?.deleted_at, `${record.objectType} is live again`).toBeNull();
    }
  });

  it('still answers 404, and leaves the record deleted, for a record outside the team', async () => {
    const elsewhere = await deletedContact(tenantA, outsider.userId, 'OtherTeam');
    expect(idsOf(await list(manager.token, 'contact', '&limit=100'))).not.toContain(elsewhere);

    const response = await restore(manager.token, 'contact', elsewhere);
    expect(response.status).toBe(404);
    const row = await rowsOf<{ deleted_at: Date | null }>(
      'select deleted_at from contacts where id = $1',
      [elsewhere],
    );
    expect(row[0]?.deleted_at).not.toBeNull();
  });

  it('judges the owner’s team at restore time: a teammate who has left cannot be restored for', async () => {
    const mover = await userWithRole(tenantA, rolesA.get('Sales Rep')!);
    const team = await harness.fixtures.createTeam(tenantA, `Bin movers ${newId()}`, [
      manager.userId,
      mover.userId,
    ]);
    const deleted = await deletedContact(tenantA, mover.userId, 'Leaver');
    expect((await restore(manager.token, 'contact', deleted)).status).toBe(200);

    const deletedAgain = await deletedContact(tenantA, mover.userId, 'Leaver2');
    await superuser.query('delete from team_members where team_id = $1 and user_id = $2', [
      team,
      mover.userId,
    ]);
    expect((await restore(manager.token, 'contact', deletedAgain)).status).toBe(404);
  });
});

describe('restore re-checks permission at restore time (MVP_SPEC M4)', () => {
  it('refuses a role that can read but not delete', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `Reader ${newId()}`);
    await harness.fixtures.grant(tenantA, roleId, 'contact', 'read', 'all');
    const reader = await userWithRole(tenantA, roleId);

    const deleted = await deletedContact(tenantA, adminA.userId);

    // It is listed — reading the Bin needs `read` — but cannot be put back.
    expect(idsOf(await list(reader.token, 'contact', '&limit=100'))).toContain(deleted);
    expect((await restore(reader.token, 'contact', deleted)).status).toBe(403);
  });

  it('does not inherit the right from whoever deleted the record', async () => {
    // Deleted while the rep owned it; the rep's own grant is what decides now,
    // and it no longer covers the record because ownership moved.
    const deleted = await deletedContact(tenantA, ownDeleterA.userId);
    await superuser.query('update contacts set owner_id = $2 where id = $1', [
      deleted,
      ownDeleterB.userId,
    ]);

    expect((await restore(ownDeleterA.token, 'contact', deleted)).status).toBe(404);
    // Whereas the new owner, who holds the same grant, may.
    expect((await restore(ownDeleterB.token, 'contact', deleted)).status).toBe(200);
  });

  it('restores for someone who may, bumping the version and writing audit + outbox', async () => {
    const deleted = await deletedContact(tenantA, adminA.userId);

    const response = await restore(adminA.token, 'contact', deleted, 1);
    expect(response.status).toBe(200);
    expect((response.body['data'] as { version: number }).version).toBe(2);

    const row = (
      await rowsOf<{ deleted_at: Date | null; version: number }>(
        'select deleted_at, version from contacts where id = $1',
        [deleted],
      )
    )[0]!;
    expect(row.deleted_at).toBeNull();
    expect(row.version).toBe(2);

    const audit = await rowsOf<{ action: string }>(
      `select action from audit_logs where tenant_id = $1 and record_id = $2 and action = 'restore'`,
      [tenantA, deleted],
    );
    expect(audit).toHaveLength(1);

    const outbox = await rowsOf<{ event_type: string }>(
      'select event_type from outbox_events where tenant_id = $1 and record_id = $2',
      [tenantA, deleted],
    );
    expect(outbox.map((row) => row.event_type)).toContain('contact.restored.v1');
  });

  it('refuses a stale version with 409 rather than overwriting', async () => {
    const deleted = await deletedContact(tenantA, adminA.userId);
    await superuser.query('update contacts set version = 7 where id = $1', [deleted]);

    const response = await restore(adminA.token, 'contact', deleted, 1);
    expect(response.status).toBe(409);
    expect((response.body['error'] as { code: string }).code).toBe('VERSION_CONFLICT');
  });

  it('a second restore of a live record is a 404, not a second version bump', async () => {
    const deleted = await deletedContact(tenantA, adminA.userId);
    expect((await restore(adminA.token, 'contact', deleted, 1)).status).toBe(200);
    expect((await restore(adminA.token, 'contact', deleted, 2)).status).toBe(404);
  });
});

describe('field permissions on the label (CLAUDE.md §5.4)', () => {
  it('falls back to the object name rather than showing a hidden field', async () => {
    const roleId = await harness.fixtures.createRole(tenantA, `No names ${newId()}`);
    await harness.fixtures.grantAll(tenantA, roleId, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'last_name', 'hidden');
    await harness.fixtures.setFieldPermission(tenantA, roleId, 'contact', 'first_name', 'hidden');
    const blind = await userWithRole(tenantA, roleId);

    const deleted = await deletedContact(tenantA, adminA.userId, 'Confidential');

    const response = await list(blind.token, 'contact', '&limit=100');
    const entry = (response.body['data'] as { id: string; label: string }[]).find(
      (row) => row.id === deleted,
    );
    expect(entry?.label).toBe('Contact');
    expect(JSON.stringify(response.body)).not.toContain('Confidential');
  });
});

describe('input validation (CLAUDE.md §5.6, §5.7)', () => {
  it('rejects an object type outside the closed set', async () => {
    expect((await list(adminA.token, 'contacts%3B%20drop%20table')).status).toBe(422);
    expect((await restore(adminA.token, 'users', newId())).status).toBe(422);
  });

  it('requires an object type', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/recycle-bin',
      token: adminA.token,
    });
    expect(response.status).toBe(422);
  });

  it('requires a version on restore', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: `/api/v1/recycle-bin/contact/${newId()}/restore`,
      token: adminA.token,
      body: {},
    });
    expect(response.status).toBe(422);
  });
});

describe('what the Bin reports', () => {
  it('says when a record will be purged', async () => {
    const deleted = await deletedContact(tenantA, adminA.userId);
    const response = await list(adminA.token, 'contact', '&limit=100');
    const entry = (
      response.body['data'] as { id: string; deletedAt: string; purgeAfter: string }[]
    ).find((row) => row.id === deleted)!;

    const days =
      (new Date(entry.purgeAfter).getTime() - new Date(entry.deletedAt).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 5);
  });

  it('does not list live records', async () => {
    const live = newId();
    await superuser.query(
      `insert into contacts (id, tenant_id, owner_id, last_name) values ($1, $2, $3, 'Live')`,
      [live, tenantA, adminA.userId],
    );

    expect(idsOf(await list(adminA.token, 'contact', '&limit=100'))).not.toContain(live);
  });
});
