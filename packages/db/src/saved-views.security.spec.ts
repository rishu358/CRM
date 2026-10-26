import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant } from './client.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * The database's own rules for saved views and bulk-operation memory (migration 0023, ADR-0056).
 *
 * The API enforces visibility too, and its tests go through the service. These go underneath it,
 * as the application role with a hand-written statement, because the point of a policy is that a
 * bug in the service cannot show somebody a view they may not see or let them change one that is
 * not theirs.
 */

let db: TestDatabase;
let tenantA: string;
let tenantB: string;
let alice: string; // in team North
let bob: string; // in team North
let carol: string; // in no team
let dave: string; // in tenant B

const view = (id: string, tenant: string, owner: string, visibility: string) => sql`
  insert into saved_views (id, tenant_id, object_type, name, visibility, created_by)
  values (${id}::uuid, ${tenant}::uuid, 'contact', ${`view ${id.slice(-4)}`}, ${visibility}, ${owner}::uuid)`;

const as = <T>(tenant: string, user: string, work: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db.app.db, { tenantId: tenant, userId: user }, work);

const visibleIds = async (tenant: string, user: string): Promise<string[]> => {
  const result = await as(tenant, user, (tx) => tx.execute(sql`select id from saved_views`));
  return (result.rows as { id: string }[]).map((row) => row.id);
};

const ids = {
  alicePrivate: '0197c3f0-0000-7000-8000-00000000a001',
  aliceTeam: '0197c3f0-0000-7000-8000-00000000a002',
  aliceTenant: '0197c3f0-0000-7000-8000-00000000a003',
  daveTenant: '0197c3f0-0000-7000-8000-00000000d001',
};

beforeAll(async () => {
  db = createTestDatabase(inject('dbUrls'));

  tenantA = (await db.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Rival Traders' })).tenantId;
  const roleA = await db.fixtures.createRole(tenantA, 'Admin', { isSystem: true });
  const roleB = await db.fixtures.createRole(tenantB, 'Admin', { isSystem: true });
  alice = (await db.fixtures.createUser(tenantA, roleA)).userId;
  bob = (await db.fixtures.createUser(tenantA, roleA)).userId;
  carol = (await db.fixtures.createUser(tenantA, roleA)).userId;
  dave = (await db.fixtures.createUser(tenantB, roleB)).userId;
  await db.fixtures.createTeam(tenantA, 'North', [alice, bob]);

  await as(tenantA, alice, async (tx) => {
    await tx.execute(view(ids.alicePrivate, tenantA, alice, 'private'));
    await tx.execute(view(ids.aliceTeam, tenantA, alice, 'team'));
    await tx.execute(view(ids.aliceTenant, tenantA, alice, 'tenant'));
  });
  await as(tenantB, dave, (tx) => tx.execute(view(ids.daveTenant, tenantB, dave, 'tenant')));
});

afterAll(async () => {
  await db.close();
});

describe('who can see a view', () => {
  it('shows the creator all of theirs', async () => {
    expect(await visibleIds(tenantA, alice)).toEqual(
      expect.arrayContaining([ids.alicePrivate, ids.aliceTeam, ids.aliceTenant]),
    );
  });

  it('shows a teammate the team and tenant views, not the private one', async () => {
    const seen = await visibleIds(tenantA, bob);
    expect(seen).toContain(ids.aliceTeam);
    expect(seen).toContain(ids.aliceTenant);
    expect(seen).not.toContain(ids.alicePrivate);
  });

  it('shows somebody on no team only the tenant-wide view', async () => {
    const seen = await visibleIds(tenantA, carol);
    expect(seen).toEqual([ids.aliceTenant]);
  });

  it('does not show a tenant-wide view of another tenant, whatever its visibility', async () => {
    expect(await visibleIds(tenantA, alice)).not.toContain(ids.daveTenant);
    expect(await visibleIds(tenantB, dave)).toEqual([ids.daveTenant]);
  });

  it('shows nothing when no user is set on the connection', async () => {
    const result = await withTenant(db.app.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute(sql`select id from saved_views where visibility <> 'tenant'`),
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe('who can change a view', () => {
  it('lets a person update and delete their own', async () => {
    const own = '0197c3f0-0000-7000-8000-00000000a010';
    await as(tenantA, alice, (tx) => tx.execute(view(own, tenantA, alice, 'private')));
    const updated = await as(tenantA, alice, (tx) =>
      tx.execute(sql`update saved_views set name = 'renamed' where id = ${own}::uuid`),
    );
    expect(updated.rowCount).toBe(1);
    const deleted = await as(tenantA, alice, (tx) =>
      tx.execute(sql`delete from saved_views where id = ${own}::uuid`),
    );
    expect(deleted.rowCount).toBe(1);
  });

  it('changes nothing of a shared view for a colleague who can see it', async () => {
    const update = await as(tenantA, bob, (tx) =>
      tx.execute(sql`update saved_views set name = 'hijacked' where id = ${ids.aliceTenant}::uuid`),
    );
    expect(update.rowCount).toBe(0);
    const remove = await as(tenantA, bob, (tx) =>
      tx.execute(sql`delete from saved_views where id = ${ids.aliceTeam}::uuid`),
    );
    expect(remove.rowCount).toBe(0);
    expect(await visibleIds(tenantA, alice)).toEqual(
      expect.arrayContaining([ids.aliceTeam, ids.aliceTenant]),
    );
  });

  it('refuses to create a view in somebody else name', async () => {
    const error = await captureDbError(() =>
      as(tenantA, bob, (tx) =>
        tx.execute(view('0197c3f0-0000-7000-8000-00000000a011', tenantA, alice, 'private')),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses to hand a view to somebody else by updating its owner', async () => {
    const error = await captureDbError(() =>
      as(tenantA, alice, (tx) =>
        tx.execute(
          sql`update saved_views set created_by = ${bob}::uuid where id = ${ids.alicePrivate}::uuid`,
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses a view in another tenant, and a view with an object type that does not exist', async () => {
    const crossTenant = await captureDbError(() =>
      as(tenantA, alice, (tx) =>
        tx.execute(view('0197c3f0-0000-7000-8000-00000000a012', tenantB, alice, 'tenant')),
      ),
    );
    expect(crossTenant.code).toBe(INSUFFICIENT_PRIVILEGE);

    const badType = await captureDbError(() =>
      as(tenantA, alice, (tx) =>
        tx.execute(sql`insert into saved_views (id, tenant_id, object_type, name, created_by)
          values ('0197c3f0-0000-7000-8000-00000000a013'::uuid, ${tenantA}::uuid, 'spaceship', 'x', ${alice}::uuid)`),
      ),
    );
    expect(badType.code).toBe('23514');
  });

  it('refuses a visibility the policy language does not know', async () => {
    const error = await captureDbError(() =>
      as(tenantA, alice, (tx) =>
        tx.execute(view('0197c3f0-0000-7000-8000-00000000a014', tenantA, alice, 'world')),
      ),
    );
    expect(error.code).toBe('23514');
  });
});

describe('bulk_operations', () => {
  const remember = (tenant: string, user: string, key: string) =>
    as(tenant, user, (tx) =>
      tx.execute(sql`insert into bulk_operations
        (id, tenant_id, idempotency_key, object_type, action, request_hash, result, created_by)
        values (gen_random_uuid(), ${tenant}::uuid, ${key}, 'contact', 'delete', 'h', '{}'::jsonb, ${user}::uuid)`),
    );

  it('shows a person only their own remembered answers, not a colleague or another tenant', async () => {
    await remember(tenantA, alice, 'alice-key');
    await remember(tenantA, bob, 'bob-key');
    await remember(tenantB, dave, 'dave-key');

    const keys = async (tenant: string, user: string) =>
      (
        (
          await as(tenant, user, (tx) =>
            tx.execute(sql`select idempotency_key from bulk_operations`),
          )
        ).rows as { idempotency_key: string }[]
      ).map((row) => row.idempotency_key);

    expect(await keys(tenantA, alice)).toEqual(['alice-key']);
    expect(await keys(tenantA, bob)).toEqual(['bob-key']);
    expect(await keys(tenantB, dave)).toEqual(['dave-key']);
  });

  it('refuses to remember an answer in somebody else name or tenant', async () => {
    const asOther = await captureDbError(() =>
      as(tenantA, bob, (tx) =>
        tx.execute(sql`insert into bulk_operations
          (id, tenant_id, idempotency_key, object_type, action, request_hash, result, created_by)
          values (gen_random_uuid(), ${tenantA}::uuid, 'forged', 'contact', 'delete', 'h', '{}'::jsonb, ${alice}::uuid)`),
      ),
    );
    expect(asOther.code).toBe(INSUFFICIENT_PRIVILEGE);

    // A session of workspace A writing a row that says it belongs to workspace B.
    const crossTenant = await captureDbError(() =>
      as(tenantA, alice, (tx) =>
        tx.execute(sql`insert into bulk_operations
          (id, tenant_id, idempotency_key, object_type, action, request_hash, result, created_by)
          values (gen_random_uuid(), ${tenantB}::uuid, 'cross', 'contact', 'delete', 'h', '{}'::jsonb, ${alice}::uuid)`),
      ),
    );
    expect(crossTenant.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses the same key twice for one person, and a key with spaces', async () => {
    await remember(tenantA, carol, 'once');
    const twice = await captureDbError(() => remember(tenantA, carol, 'once'));
    expect(twice.code).toBe('23505');
    const spaces = await captureDbError(() => remember(tenantA, carol, 'has spaces'));
    expect(spaces.code).toBe('23514');
  });

  it('is not writable, only readable and deletable, by the worker', async () => {
    const error = await captureDbError(() =>
      withTenant(db.worker.db, { tenantId: tenantA, userId: alice }, (tx) =>
        tx.execute(sql`insert into bulk_operations
          (id, tenant_id, idempotency_key, object_type, action, request_hash, result, created_by)
          values (gen_random_uuid(), ${tenantA}::uuid, 'worker', 'contact', 'delete', 'h', '{}'::jsonb, ${alice}::uuid)`),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
