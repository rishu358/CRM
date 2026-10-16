import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant, withoutTenant } from './client.js';
import { contacts } from './schema/index.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * Tenant isolation (CLAUDE.md §5.1, §10, ADR-0002).
 *
 * These run against a real Postgres with RLS enabled. They are the tests that
 * MVP_SPEC §2 goal 2 — "zero cross-tenant data exposure, proven by automated
 * tests in CI" — actually refers to. None of them may be skipped or weakened.
 */

let db: TestDatabase;
let tenantA: { tenantId: string; adminRoleId: string };
let tenantB: { tenantId: string; adminRoleId: string };
let userA: { userId: string };
let userB: { userId: string };
let contactA: string;
let contactB: string;

beforeAll(async () => {
  db = createTestDatabase(inject('dbUrls'));

  tenantA = await db.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantB = await db.fixtures.createTenant({ name: 'Rival Traders' });

  userA = await db.fixtures.createUser(tenantA.tenantId, tenantA.adminRoleId);
  userB = await db.fixtures.createUser(tenantB.tenantId, tenantB.adminRoleId);

  contactA = await db.fixtures.createContact(tenantA.tenantId, {
    ownerId: userA.userId,
    lastName: 'Mehta',
    email: 'mehta@acme.example',
  });
  contactB = await db.fixtures.createContact(tenantB.tenantId, {
    ownerId: userB.userId,
    lastName: 'Rival',
    email: 'rival@rival.example',
  });
});

afterAll(async () => {
  await db.close();
});

describe('the application role cannot defeat RLS by construction', () => {
  it('has neither BYPASSRLS nor SUPERUSER', async () => {
    const result = await db.app.pool.query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
       WHERE rolname IN ('crm_app', 'crm_auth', 'crm_worker', 'crm_migrator')`,
    );
    expect(result.rows).toHaveLength(4);
    for (const role of result.rows) {
      expect(role.rolbypassrls, `${role.rolname} must not have BYPASSRLS`).toBe(false);
      expect(role.rolsuper, `${role.rolname} must not be a superuser`).toBe(false);
    }
  });

  it('owns no tables, so it is never exempt from a policy', async () => {
    const result = await db.app.pool.query<{ tablename: string; tableowner: string }>(
      `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const table of result.rows) {
      expect(table.tableowner, `${table.tablename} must be owned by crm_migrator`).toBe(
        'crm_migrator',
      );
    }
  });

  it('has RLS enabled AND forced on every table carrying a tenant_id', async () => {
    // Catches the failure mode this whole design guards against: a new table
    // added later that nobody remembered to protect.
    const result = await db.app.pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND EXISTS (
           SELECT 1 FROM information_schema.columns col
           WHERE col.table_schema = 'public'
             AND col.table_name = c.relname
             AND col.column_name = 'tenant_id'
         )
       ORDER BY c.relname`,
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(14);
    for (const table of result.rows) {
      expect(table.relrowsecurity, `${table.relname} must ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(
        table.relforcerowsecurity,
        `${table.relname} must FORCE ROW LEVEL SECURITY, or its owner is exempt`,
      ).toBe(true);
    }
  });
});

describe('tenant A cannot reach tenant B records (CLAUDE.md §10a)', () => {
  it('cannot list them', async () => {
    const rows = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.select().from(contacts),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(contactA);
  });

  it('cannot read one by id, even knowing the id exactly', async () => {
    const rows = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`select id from contacts where id = ${contactB}`),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('cannot update one', async () => {
    const result = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`update contacts set last_name = 'Hacked' where id = ${contactB}`),
    );
    expect(result.rowCount).toBe(0);

    // And the row is genuinely untouched when read from outside the boundary.
    const check = await withTenant(
      db.app.db,
      { tenantId: tenantB.tenantId, userId: userB.userId },
      (tx) => tx.execute(sql`select last_name from contacts where id = ${contactB}`),
    );
    expect(check.rows[0]).toMatchObject({ last_name: 'Rival' });
  });

  it('cannot delete one', async () => {
    const result = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`delete from contacts where id = ${contactB}`),
    );
    expect(result.rowCount).toBe(0);
  });

  it('cannot insert a row carrying another tenant id', async () => {
    // The WITH CHECK half of the policy. Without it, a forged tenant_id in a
    // payload would write straight into another customer's data.
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(
          sql`insert into contacts (id, tenant_id, last_name)
              values (gen_random_uuid(), ${tenantB.tenantId}, 'Smuggled')`,
        ),
      ),
    );
    expect(error.message).toMatch(/row-level security/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot move a row into another tenant by updating tenant_id', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(sql`update contacts set tenant_id = ${tenantB.tenantId} where id = ${contactA}`),
      ),
    );
    expect(error.message).toMatch(/row-level security/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot see another tenant permission configuration', async () => {
    const rows = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`select id from roles`),
    );
    const ids = rows.rows.map((row) => (row as { id: string }).id);
    expect(ids).toContain(tenantA.adminRoleId);
    expect(ids).not.toContain(tenantB.adminRoleId);
  });

  it('sees only its own tenant row in the registry', async () => {
    const rows = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`select id from tenants`),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: tenantA.tenantId });
  });
});

describe('the system fails closed without tenant context', () => {
  it('returns no rows at all when app.tenant_id is unset', async () => {
    // current_tenant_id() is NULL, so `tenant_id = NULL` is NULL, which is not
    // true. A forgotten withTenant() yields emptiness, never another tenant.
    const rows = await withoutTenant(db.app.db, (tx) => tx.execute(sql`select id from contacts`));
    expect(rows.rows).toHaveLength(0);
  });

  it('rejects an insert when app.tenant_id is unset', async () => {
    const error = await captureDbError(() =>
      withoutTenant(db.app.db, (tx) =>
        tx.execute(
          sql`insert into contacts (id, tenant_id, last_name)
              values (gen_random_uuid(), ${tenantA.tenantId}, 'Orphan')`,
        ),
      ),
    );
    expect(error.message).toMatch(/row-level security/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses a malformed tenant id rather than falling back to no context', async () => {
    await expect(
      withTenant(db.app.db, { tenantId: '', userId: null }, (tx) => tx.execute(sql`select 1`)),
    ).rejects.toThrow(TypeError);
    await expect(
      withTenant(db.app.db, { tenantId: 'not-a-uuid', userId: null }, (tx) =>
        tx.execute(sql`select 1`),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('does not leak tenant context to the next user of a pooled connection', async () => {
    // SET LOCAL is transaction-scoped. If this were plain SET, the setting
    // would survive on the pooled backend and the next request could read the
    // previous tenant's rows — a leak that only shows up under concurrency.
    await withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
      tx.execute(sql`select id from contacts`),
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const leaked = await withoutTenant(db.app.db, (tx) =>
        tx.execute(sql`select current_tenant_id() as tenant_id`),
      );
      expect(leaked.rows[0]).toMatchObject({ tenant_id: null });
    }
  });
});

describe('the global user directory is scoped by membership (ADR-0014)', () => {
  it('shows only users who share the current tenant', async () => {
    const rows = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`select id from users`),
    );
    const ids = rows.rows.map((row) => (row as { id: string }).id);
    expect(ids).toContain(userA.userId);
    expect(ids).not.toContain(userB.userId);
  });

  it('lets a user edit their own profile but not a colleague profile', async () => {
    const colleague = await db.fixtures.createUser(tenantA.tenantId, tenantA.adminRoleId);

    const own = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`update users set name = 'Renamed' where id = ${userA.userId}`),
    );
    expect(own.rowCount).toBe(1);

    const other = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) => tx.execute(sql`update users set name = 'Hijacked' where id = ${colleague.userId}`),
    );
    expect(other.rowCount).toBe(0);
  });

  it('denies the app role any access to auth tables', async () => {
    // The auth layer runs as a separate role precisely so that a flaw in the
    // application cannot read password hashes or session tokens.
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(sql`select token from sessions`),
      ),
    );
    expect(error.message).toMatch(/permission denied/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('denies the app role any access to password hashes', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(sql`select password_hash from auth_accounts`),
      ),
    );
    expect(error.message).toMatch(/permission denied/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('denies the auth role any access to business tables', async () => {
    const error = await captureDbError(() =>
      withTenant(db.auth.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(sql`select id from contacts`),
      ),
    );
    expect(error.message).toMatch(/permission denied/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('the audit log is append-only (CLAUDE.md §5.10)', () => {
  it('accepts an insert inside tenant context', async () => {
    const result = await withTenant(
      db.app.db,
      { tenantId: tenantA.tenantId, userId: userA.userId },
      (tx) =>
        tx.execute(
          sql`insert into audit_logs (id, tenant_id, actor_id, action, object_type, record_id)
              values (gen_random_uuid(), ${tenantA.tenantId}, ${userA.userId}, 'create', 'contact', ${contactA})`,
        ),
    );
    expect(result.rowCount).toBe(1);
  });

  it('refuses UPDATE, so history cannot be rewritten', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(sql`update audit_logs set action = 'nothing_happened'`),
      ),
    );
    expect(error.message).toMatch(/permission denied/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses DELETE, so history cannot be erased', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(sql`delete from audit_logs`),
      ),
    );
    expect(error.message).toMatch(/permission denied/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('still isolates audit rows by tenant', async () => {
    const rows = await withTenant(
      db.app.db,
      { tenantId: tenantB.tenantId, userId: userB.userId },
      (tx) => tx.execute(sql`select id from audit_logs`),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe('the outbox is tenant-scoped for the API and global for the relay', () => {
  it('lets the API write and read only its own tenant events', async () => {
    await withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
      tx.execute(
        sql`insert into outbox_events (id, tenant_id, event_type, object_type, record_id)
            values (gen_random_uuid(), ${tenantA.tenantId}, 'contact.created.v1', 'contact', ${contactA})`,
      ),
    );

    const fromB = await withTenant(
      db.app.db,
      { tenantId: tenantB.tenantId, userId: userB.userId },
      (tx) => tx.execute(sql`select id from outbox_events`),
    );
    expect(fromB.rows).toHaveLength(0);
  });

  it('refuses to let the API update an event, which is the relay job', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA.tenantId, userId: userA.userId }, (tx) =>
        tx.execute(sql`update outbox_events set status = 'relayed'`),
      ),
    );
    expect(error.message).toMatch(/permission denied/i);
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('lets the relay role drain events across tenants', async () => {
    // The documented exception to tenant scoping (ADR-0002): one queue, one
    // worker, confined to this table and this role.
    await withTenant(db.app.db, { tenantId: tenantB.tenantId, userId: userB.userId }, (tx) =>
      tx.execute(
        sql`insert into outbox_events (id, tenant_id, event_type, object_type, record_id)
            values (gen_random_uuid(), ${tenantB.tenantId}, 'contact.created.v1', 'contact', ${contactB})`,
      ),
    );

    const drained = await withoutTenant(db.worker.db, (tx) =>
      tx.execute(sql`select distinct tenant_id from outbox_events`),
    );
    const tenantIds = drained.rows.map((row) => (row as { tenant_id: string }).tenant_id);
    expect(tenantIds).toEqual(expect.arrayContaining([tenantA.tenantId, tenantB.tenantId]));
  });

  it('does not extend the relay exception to business tables', async () => {
    // The worker may see every tenant's events, but must still open a
    // tenant-scoped transaction before touching their data.
    const rows = await withoutTenant(db.worker.db, (tx) =>
      tx.execute(sql`select id from contacts`),
    );
    expect(rows.rows).toHaveLength(0);
  });
});
