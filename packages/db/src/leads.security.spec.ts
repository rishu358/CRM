import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant } from './client.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * What migration 0009 guarantees about leads *without* the service in the way
 * (CLAUDE.md §5.1, §12): isolation, tenant-bound references, and a conversion
 * that cannot be undone. An import, a seed or a future code path writes
 * through the same constraints, so they are asserted at the database.
 */

/**
 * `leads_assert_conversion_final()` raises `check_violation` (23514) with this
 * text. The message is asserted because `captureDbError` reports the message
 * and the SQLSTATE, and a RAISE EXCEPTION's message is its prose, not the
 * constraint name a CHECK would put in it.
 */
const CHECK_VIOLATION = '23514';
const FINAL_MESSAGE = 'has already been converted';

let db: TestDatabase;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let contactA: string;
let contactA2: string;
let contactB: string;
let leadA: string;
let leadB: string;

/** Run SQL as the superuser, so a test can attempt what the service never would. */
async function raw(query: string, params: unknown[] = []): Promise<void> {
  await superuser.query(query, params);
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  db = createTestDatabase(urls);
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await db.fixtures.createTenant({ name: 'Leads A' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Leads B' })).tenantId;
  contactA = await db.fixtures.createContact(tenantA, { lastName: 'AContact' });
  contactA2 = await db.fixtures.createContact(tenantA, { lastName: 'AContactTwo' });
  contactB = await db.fixtures.createContact(tenantB, { lastName: 'BContact' });
  leadA = await db.fixtures.createLead(tenantA, { lastName: 'ALead' });
  leadB = await db.fixtures.createLead(tenantB, { lastName: 'BLead' });
});

afterAll(async () => {
  await superuser.end();
  await db.close();
});

describe('row-level security on leads', () => {
  it('shows a tenant only its own leads', async () => {
    const rows = await withTenant(db.app.db, { tenantId: tenantA, userId: null }, (tx) =>
      tx.execute<{ id: string }>(sql`select id from leads`),
    );
    const ids = rows.rows.map((row) => row.id);
    expect(ids).toContain(leadA);
    expect(ids).not.toContain(leadB);
  });

  it('shows nothing outside a tenant-scoped transaction', async () => {
    const rows = await db.app.db.execute<{ id: string }>(sql`select id from leads`);
    expect(rows.rows).toEqual([]);
  });

  it('refuses to insert a lead for another tenant', async () => {
    const error = await captureDbError(() =>
      withTenant(db.app.db, { tenantId: tenantA, userId: null }, (tx) =>
        tx.execute(
          sql`insert into leads (id, tenant_id, last_name)
              values (gen_random_uuid(), ${tenantB}, 'Planted')`,
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot update or delete another tenant lead', async () => {
    await withTenant(db.app.db, { tenantId: tenantA, userId: null }, async (tx) => {
      const updated = await tx.execute(
        sql`update leads set last_name = 'Hacked' where id = ${leadB}`,
      );
      const deleted = await tx.execute(sql`delete from leads where id = ${leadB}`);
      expect(updated.rowCount).toBe(0);
      expect(deleted.rowCount).toBe(0);
    });
  });
});

describe('conversion links stay inside one tenant', () => {
  it('refuses a converted contact from another tenant', async () => {
    const error = await captureDbError(() =>
      db.fixtures.createLead(tenantA, {
        lastName: 'CrossLink',
        status: 'converted',
        convertedAt: new Date(),
        convertedContactId: contactB,
      }),
    );
    expect(error.code).toBe('23503');
    expect(error.message).toContain('leads_converted_contact_same_tenant_fkey');
  });

  it('accepts the same link inside the tenant', async () => {
    await expect(
      db.fixtures.createLead(tenantA, {
        lastName: 'SameTenant',
        status: 'converted',
        convertedAt: new Date(),
        convertedContactId: contactA,
      }),
    ).resolves.toBeTypeOf('string');
  });
});

describe('the converted state agrees with itself', () => {
  it('refuses status converted without a converted_at', async () => {
    const error = await captureDbError(() =>
      db.fixtures.createLead(tenantA, { lastName: 'NoDate', status: 'converted' }),
    );
    expect(error.message).toContain('leads_converted_state_chk');
  });

  it('refuses a converted_at on a lead that is not converted', async () => {
    const error = await captureDbError(() =>
      db.fixtures.createLead(tenantA, { lastName: 'EarlyDate', convertedAt: new Date() }),
    );
    expect(error.message).toContain('leads_converted_state_chk');
  });

  it('refuses conversion links on a lead that is not converted', async () => {
    const error = await captureDbError(() =>
      db.fixtures.createLead(tenantA, { lastName: 'EarlyLink', convertedContactId: contactA }),
    );
    expect(error.message).toContain('leads_converted_links_chk');
  });

  it('refuses a status outside the five, a blank surname and a malformed phone', async () => {
    const status = await captureDbError(() =>
      raw(
        `insert into leads (id, tenant_id, last_name, status)
         values (gen_random_uuid(), $1, 'X', 'won')`,
        [tenantA],
      ),
    );
    expect(status.message).toContain('leads_status_chk');

    const surname = await captureDbError(() =>
      db.fixtures.createLead(tenantA, { lastName: '   ' }),
    );
    expect(surname.message).toContain('leads_last_name_chk');

    const phone = await captureDbError(() =>
      db.fixtures.createLead(tenantA, { lastName: 'Phone', phone: '98765' }),
    );
    expect(phone.message).toContain('leads_phone_chk');
  });
});

describe('a conversion is permanent (ADR-0022)', () => {
  let converted: string;

  beforeAll(async () => {
    converted = await db.fixtures.createLead(tenantA, {
      lastName: 'Finished',
      status: 'converted',
      convertedAt: new Date('2026-01-01T00:00:00Z'),
      convertedContactId: contactA,
    });
  });

  it('refuses to re-point a link', async () => {
    const error = await captureDbError(() =>
      raw(`update leads set converted_contact_id = $2 where id = $1`, [converted, contactA2]),
    );
    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.message).toContain(FINAL_MESSAGE);
    expect((await db.fixtures.leadRow(converted))?.converted_contact_id).toBe(contactA);
  });

  it('refuses to add a link that was never set', async () => {
    const account = await db.fixtures.createAccount(tenantA, { name: 'Late Account' });
    const error = await captureDbError(() =>
      raw(`update leads set converted_account_id = $2 where id = $1`, [converted, account]),
    );
    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.message).toContain(FINAL_MESSAGE);
  });

  it('refuses to un-convert, and to move the converted_at', async () => {
    const reopen = await captureDbError(() =>
      raw(`update leads set status = 'contacted' where id = $1`, [converted]),
    );
    expect(reopen.code).toBe(CHECK_VIOLATION);
    expect(reopen.message).toContain(FINAL_MESSAGE);

    const clear = await captureDbError(() =>
      raw(
        `update leads set status = 'contacted', converted_at = null,
                converted_contact_id = null where id = $1`,
        [converted],
      ),
    );
    expect(clear.message).toBeDefined();
    expect((await db.fixtures.leadRow(converted))?.status).toBe('converted');

    const moved = await captureDbError(() =>
      raw(`update leads set converted_at = now() where id = $1`, [converted]),
    );
    expect(moved.code).toBe(CHECK_VIOLATION);
    expect(moved.message).toContain(FINAL_MESSAGE);
  });

  it('still lets an unrelated column change', async () => {
    await raw(`update leads set company = 'Renamed Co' where id = $1`, [converted]);
    const row = await superuser.query(`select company from leads where id = $1`, [converted]);
    expect(row.rows[0]).toEqual({ company: 'Renamed Co' });
  });

  it('lets a hard delete of the contact null the link instead of failing', async () => {
    const doomed = await db.fixtures.createContact(tenantA, { lastName: 'Doomed' });
    const lead = await db.fixtures.createLead(tenantA, {
      lastName: 'Orphan',
      status: 'converted',
      convertedAt: new Date(),
      convertedContactId: doomed,
    });

    await raw(`delete from contacts where id = $1`, [doomed]);

    const row = await db.fixtures.leadRow(lead);
    expect(row?.converted_contact_id).toBeNull();
    // The lead is still converted: only the pointer went.
    expect(row?.status).toBe('converted');
  });
});
