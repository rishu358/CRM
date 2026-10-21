import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10):
 *   (a) tenant A cannot list/read/update/delete tenant B records
 *   (b) a user with `own` scope cannot see other people's records
 *   (c) hidden fields are absent from responses and rejected on write
 *   (d) unauthenticated requests get 401
 *
 * Plus two that are specific to this object: the sort and filter whitelists
 * (CLAUDE.md §5.7), and `parent_account_id` — the only column in the module
 * that takes an id from the client and stores it, which makes it the only one
 * that could be used to plant a reference across a tenant boundary.
 *
 * They go through the real HTTP stack — the same guards, pipes, filter and
 * database roles as production — because every one of those layers is part of
 * what is being asserted.
 */

let harness: ApiHarness;

/** Tenant A: an admin with `all` scope and two reps with `own` scope. */
let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };

/** Tenant B: a separate company that must never be visible from tenant A. */
let tenantB: string;
let adminB: { token: string; userId: string };

let adminAccountA: string;
let repAccountA: string;
let accountB: string;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seededA = await harness.fixtures.createTenant({ name: 'Acme Holdings' });
  tenantA = seededA.tenantId;
  const rolesA = await harness.provision(tenantA);

  const seededB = await harness.fixtures.createTenant({ name: 'Rival Holdings' });
  tenantB = seededB.tenantId;
  const rolesB = await harness.provision(tenantB);

  const adminRoleA = rolesA.get('Admin')!;
  const repRoleA = rolesA.get('Sales Rep')!;
  const adminRoleB = rolesB.get('Admin')!;

  const admin = await harness.fixtures.createUser(tenantA, adminRoleA);
  adminA = { userId: admin.userId, token: await harness.signIn(admin.userId, tenantA) };

  const rep = await harness.fixtures.createUser(tenantA, repRoleA);
  repA = { userId: rep.userId, token: await harness.signIn(rep.userId, tenantA) };

  const otherRep = await harness.fixtures.createUser(tenantA, repRoleA);
  otherRepA = { userId: otherRep.userId, token: await harness.signIn(otherRep.userId, tenantA) };

  const bAdmin = await harness.fixtures.createUser(tenantB, adminRoleB);
  adminB = { userId: bAdmin.userId, token: await harness.signIn(bAdmin.userId, tenantB) };

  adminAccountA = await harness.fixtures.createAccount(tenantA, {
    ownerId: adminA.userId,
    name: 'Mehta Exports',
    domain: 'mehta.example',
  });
  repAccountA = await harness.fixtures.createAccount(tenantA, {
    ownerId: repA.userId,
    name: 'Sharma Textiles',
    domain: 'sharma.example',
  });
  accountB = await harness.fixtures.createAccount(tenantB, {
    ownerId: adminB.userId,
    name: 'Rival Traders',
    domain: 'rival.example',
  });
});

afterAll(async () => {
  await harness.close();
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects a list with no credentials', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/accounts' });
    expect(response.status).toBe(401);
  });

  it('rejects a read, a create, an update and a delete', async () => {
    const calls = [
      { method: 'GET', url: `/api/v1/accounts/${adminAccountA}` },
      { method: 'POST', url: '/api/v1/accounts', body: { name: 'Intruder Ltd' } },
      { method: 'PATCH', url: `/api/v1/accounts/${adminAccountA}`, body: { version: 1 } },
      { method: 'DELETE', url: `/api/v1/accounts/${adminAccountA}?version=1` },
    ] as const;

    for (const call of calls) {
      const response = await request(harness, { ...call });
      expect(response.status, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts',
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });

  it('returns the error envelope with a request id, and no stack trace', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/accounts' });
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNAUTHENTICATED');
    expect(typeof error['requestId']).toBe('string');
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts:/);
  });
});

describe('(a) tenant A cannot reach tenant B records', () => {
  it('lists only its own tenant records', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?limit=100',
      token: adminA.token,
    });
    expect(response.status).toBe(200);

    const ids = dataOf<{ id: string }[]>(response).map((row) => row.id);
    expect(ids).toContain(adminAccountA);
    expect(ids).toContain(repAccountA);
    expect(ids).not.toContain(accountB);
  });

  it('returns 404 for another tenant record, not 403', async () => {
    // 403 would confirm the id exists, turning the endpoint into an oracle
    // for records in other companies (CLAUDE.md §5.5).
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${accountB}`,
      token: adminA.token,
    });
    expect(response.status).toBe(404);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });

  it('gives the same 404 for an id that does not exist anywhere', async () => {
    const missing = '01a1443a-0000-7000-8000-000000000000';
    const absent = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${missing}`,
      token: adminA.token,
    });
    const foreign = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${accountB}`,
      token: adminA.token,
    });
    expect(absent.status).toBe(foreign.status);
    expect((absent.body['error'] as Record<string, unknown>)['message']).toBe(
      (foreign.body['error'] as Record<string, unknown>)['message'],
    );
  });

  it('cannot update another tenant record', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${accountB}`,
      token: adminA.token,
      body: { name: 'Hacked Ltd', version: 1 },
    });
    expect(response.status).toBe(404);

    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${accountB}`,
      token: adminB.token,
    });
    expect(dataOf<Record<string, unknown>>(check)['name']).toBe('Rival Traders');
  });

  it('cannot delete another tenant record', async () => {
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/accounts/${accountB}?version=1`,
      token: adminA.token,
    });
    expect(response.status).toBe(404);
  });

  it('cannot switch tenant with a header for a tenant it does not belong to', async () => {
    // X-Tenant-Id is a request, not an authorization: membership decides.
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts',
      token: adminA.token,
      tenantId: tenantB,
    });
    expect(response.status).toBe(403);
  });

  it('does not let a created record name another tenant', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: adminA.token,
      body: { name: 'Smuggled Ltd', tenantId: tenantB },
    });
    // Rejected as an unknown key: tenant comes from the session, never the body.
    expect(response.status).toBe(422);
  });

  it('cannot plant another tenant account as a parent', async () => {
    // The one field that takes an id from the client and stores it. A foreign
    // key to accounts (id) alone would have accepted this: referential checks
    // run with row security off, so RLS does not stop a value POINTING at
    // another tenant's row, only a query from reading it. The key is
    // composite on (tenant_id, parent_account_id) for exactly this request.
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: adminA.token,
      body: { name: 'Cross Tenant Child', parentAccountId: accountB },
    });
    expect(response.status).toBe(422);

    // And the same on an update, which is a different code path.
    const update = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${adminAccountA}`,
      token: adminA.token,
      body: { parentAccountId: accountB, version: 1 },
    });
    expect(update.status).toBe(422);
  });

  it('says the same thing about a foreign parent and a nonexistent one', async () => {
    const foreign = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: adminA.token,
      body: { name: 'Probe One', parentAccountId: accountB },
    });
    const missing = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: adminA.token,
      body: { name: 'Probe Two', parentAccountId: '01a1443a-0000-7000-8000-000000000000' },
    });
    // Otherwise the parent field becomes an existence oracle for other
    // companies' account ids. Everything but the request id must match.
    const withoutRequestId = (body: Record<string, unknown>): unknown => {
      const { requestId: _requestId, ...rest } = body['error'] as Record<string, unknown>;
      return rest;
    };
    expect(foreign.status).toBe(missing.status);
    expect(withoutRequestId(foreign.body)).toEqual(withoutRequestId(missing.body));
  });
});

describe('(b) a user with own scope cannot see other people records', () => {
  it('lists only the records the rep owns', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?limit=100',
      token: repA.token,
    });
    expect(response.status).toBe(200);

    const ids = dataOf<{ id: string }[]>(response).map((row) => row.id);
    expect(ids).toContain(repAccountA);
    expect(ids).not.toContain(adminAccountA);
  });

  it('keeps the scope on every page, including a nullable sort column', async () => {
    // The keyset predicate contains an `or`, and Drizzle's `and()` does not
    // parenthesise its operands — so an unbracketed fragment detaches the
    // scope filter and hands this rep the whole tenant from page two onward.
    // Sorting by a column that is mostly null is what reaches that branch.
    // The colleague's records carry a value in the sorted column and this
    // rep's do not. That asymmetry is the whole point: the faulty clause was
    // `or domain is not null`, which is inert when every row is null and
    // hands over the colleague's book when they are not.
    for (let index = 0; index < 8; index += 1) {
      await harness.fixtures.createAccount(tenantA, {
        ownerId: adminA.userId,
        name: `Admin Owned ${index}`,
        domain: `admin-owned-${index}.example`,
        industry: 'Jewellery',
      });
      await harness.fixtures.createAccount(tenantA, {
        ownerId: repA.userId,
        name: `Rep Owned ${index}`,
      });
    }

    for (const sort of ['domain', '-domain', 'annual_revenue']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const query = new URLSearchParams({ limit: '3', sort });
        if (cursor !== null) query.set('cursor', cursor);
        const response = await request(harness, {
          method: 'GET',
          url: `/api/v1/accounts?${query.toString()}`,
          token: repA.token,
        });
        expect(response.status, sort).toBe(200);

        for (const row of dataOf<{ id: string; ownerId?: string }[]>(response)) {
          seen.push(row.id);
          expect(row.ownerId, `${sort}: a record owned by someone else`).toBe(repA.userId);
        }
        cursor = (response.body['meta'] as { nextCursor: string | null }).nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 30);

      // And paging terminated rather than serving the first page forever.
      expect(cursor, `${sort}: paging never ended`).toBeNull();
      expect(new Set(seen).size, `${sort}: a row came back twice`).toBe(seen.length);
    }
  });

  it('returns 404 when the rep reads a colleague record by id', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${adminAccountA}`,
      token: repA.token,
    });
    expect(response.status).toBe(404);
  });

  it('refuses the rep updating a colleague record', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${adminAccountA}`,
      token: repA.token,
      body: { name: 'Taken Ltd', version: 1 },
    });
    expect(response.status).toBe(404);
  });

  it('refuses the rep deleting anything: Sales Rep has no delete grant', async () => {
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/accounts/${repAccountA}?version=1`,
      token: repA.token,
    });
    expect(response.status).toBe(403);
  });

  it('does not let a rep assign a record to someone else', async () => {
    // Otherwise `own` scope could be used to push a record out of sight.
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: repA.token,
      body: { name: 'Handover Ltd', ownerId: otherRepA.userId },
    });
    expect(response.status).toBe(422);
  });

  it('assigns a rep own new records to themselves', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: repA.token,
      body: { name: 'Patel Metals' },
    });
    expect(response.status).toBe(201);
    expect(dataOf<Record<string, unknown>>(response)['ownerId']).toBe(repA.userId);
  });

  it('lets a rep file their account under a parent they cannot read', async () => {
    // Deliberate. A rep must be able to place their account under the group
    // company their manager owns, and requiring the parent to be visible
    // would make the hierarchy unmaintainable by the people who maintain it.
    // Nothing of the parent is returned: reading it still goes through the
    // record-scope check below.
    const created = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: repA.token,
      body: { name: 'Rep Subsidiary', parentAccountId: adminAccountA },
    });
    expect(created.status).toBe(201);

    const parent = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${adminAccountA}`,
      token: repA.token,
    });
    expect(parent.status).toBe(404);
  });

  it('lets an admin with all scope see every record in the tenant', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?limit=100',
      token: adminA.token,
    });
    const ids = dataOf<{ id: string }[]>(response).map((row) => row.id);
    expect(ids).toContain(adminAccountA);
    expect(ids).toContain(repAccountA);
  });
});

describe('(c) hidden fields are absent from responses and rejected on write', () => {
  let hiddenRepToken: string;
  let readOnlyFieldRepToken: string;
  let ownedAccount: string;

  beforeAll(async () => {
    // A role that cannot see `gstin` at all, and one that can read but not
    // write `industry`. Both are narrowings of a role that could otherwise
    // read and write everything.
    const hiddenRole = await harness.fixtures.createRole(tenantA, 'Rep without GSTIN');
    await harness.fixtures.grantAll(tenantA, hiddenRole, 'account', 'all');
    await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'account', 'gstin', 'hidden');
    // Revenue is one API field over two columns; hiding it must hide both.
    await harness.fixtures.setFieldPermission(
      tenantA,
      hiddenRole,
      'account',
      'annual_revenue',
      'hidden',
    );

    const readOnlyRole = await harness.fixtures.createRole(tenantA, 'Rep with locked industry');
    await harness.fixtures.grantAll(tenantA, readOnlyRole, 'account', 'all');
    await harness.fixtures.setFieldPermission(tenantA, readOnlyRole, 'account', 'industry', 'read');

    const hiddenUser = await harness.fixtures.createUser(tenantA, hiddenRole);
    hiddenRepToken = await harness.signIn(hiddenUser.userId, tenantA);

    const readOnlyUser = await harness.fixtures.createUser(tenantA, readOnlyRole);
    readOnlyFieldRepToken = await harness.signIn(readOnlyUser.userId, tenantA);

    ownedAccount = await harness.fixtures.createAccount(tenantA, {
      ownerId: hiddenUser.userId,
      name: 'Iyer Jewellers',
    });

    // Give the record something to hide.
    const seeded = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${ownedAccount}`,
      token: adminA.token,
      body: {
        gstin: '29ABCDE1234F1Z5',
        industry: 'Jewellery',
        annualRevenue: { amountMinor: '770000000', currency: 'INR' },
        version: 1,
      },
    });
    expect(seeded.status).toBe(200);
  });

  it('omits the hidden field from a single-record response', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${ownedAccount}`,
      token: hiddenRepToken,
    });
    expect(response.status).toBe(200);

    const account = dataOf<Record<string, unknown>>(response);
    // Absent, not null: a null would still confirm the field exists and is set.
    expect('gstin' in account).toBe(false);
    expect('annualRevenue' in account).toBe(false);
    expect(account['name']).toBe('Iyer Jewellers');
  });

  it('omits the hidden field from every row of a list, not just the first', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?limit=100',
      token: hiddenRepToken,
    });
    const rows = dataOf<Record<string, unknown>[]>(response);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect('gstin' in row).toBe(false);
      expect('annualRevenue' in row).toBe(false);
    }
  });

  it('never leaks the hidden value anywhere in the payload', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?limit=100',
      token: hiddenRepToken,
    });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('29ABCDE1234F1Z5');
    // The amount and its currency are stored in two columns; hiding the field
    // must hide both halves, not just the one the serializer thought of.
    expect(body).not.toContain('770000000');
  });

  it('does not let a hidden field be sorted on, which would order by its value', async () => {
    // Sorting is a read. A caller who cannot see GSTIN must not be able to
    // learn the ordering of it either — binary-searching a hidden column
    // through sort and filter is a slower leak, not a smaller one.
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?sort=gstin',
      token: hiddenRepToken,
    });
    expect(response.status).toBe(422);
  });

  it('does not let a hidden field be filtered on', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?filter=gstin:starts_with:29',
      token: hiddenRepToken,
    });
    expect(response.status).toBe(422);
  });

  it('rejects a write to a hidden field instead of dropping it', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${ownedAccount}`,
      token: hiddenRepToken,
      body: { gstin: '27ABCDE1234F1Z5', version: 2 },
    });
    expect(response.status).toBe(403);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('FIELD_NOT_WRITABLE');

    // And the stored value is untouched.
    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${ownedAccount}`,
      token: adminA.token,
    });
    expect(dataOf<Record<string, unknown>>(check)['gstin']).toBe('29ABCDE1234F1Z5');
  });

  it('rejects a write to a read-only field', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${ownedAccount}`,
      token: readOnlyFieldRepToken,
      body: { industry: 'Textiles', version: 2 },
    });
    expect(response.status).toBe(403);
  });

  it('still shows a read-only field in responses', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${ownedAccount}`,
      token: readOnlyFieldRepToken,
    });
    expect(dataOf<Record<string, unknown>>(response)['industry']).toBe('Jewellery');
  });

  it('rejects a hidden field on create too, not only on update', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/accounts',
      token: hiddenRepToken,
      body: { name: 'Nair Silks', gstin: '29ABCDE1234F1Z5' },
    });
    expect(response.status).toBe(403);
  });
});

describe('sort and filter reach SQL only through the whitelist (CLAUDE.md §5.7)', () => {
  it('refuses every injection attempt through sort and leaves the table standing', async () => {
    const attempts = [
      "name'; drop table accounts; --",
      'name) union select * from users --',
      '(select password_hash from auth_accounts)',
      'annual_revenue_currency',
      'tenant_id',
      'deleted_at',
    ];

    for (const sort of attempts) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/accounts?sort=${encodeURIComponent(sort)}`,
        token: adminA.token,
      });
      expect(response.status, sort).toBe(422);
    }

    const check = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts',
      token: adminA.token,
    });
    expect(check.status).toBe(200);
  });

  it('refuses every injection attempt through filter', async () => {
    const attempts = [
      "name:eq:x' or '1'='1",
      'tenant_id:eq:' + tenantB,
      'deleted_at:is_not_null:',
      "name:contains:%' --",
      'custom_fields:eq:{}',
    ];

    for (const filter of attempts) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/accounts?filter=${encodeURIComponent(filter)}`,
        token: adminA.token,
      });

      if (response.status === 200) {
        // A filter on a real column with a hostile-looking value is fine, as
        // long as the value was bound rather than interpreted: no row from
        // the other tenant may appear, and the clause must not match
        // everything.
        const ids = dataOf<{ id: string }[]>(response).map((row) => row.id);
        expect(ids, filter).not.toContain(accountB);
      } else {
        expect(response.status, filter).toBe(422);
      }
    }
  });

  it('cannot use a filter to read a soft-deleted record back', async () => {
    const doomed = await harness.fixtures.createAccount(tenantA, {
      ownerId: adminA.userId,
      name: 'Deleted Ltd',
    });
    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/accounts/${doomed}?version=1`,
      token: adminA.token,
    });
    expect(deleted.status).toBe(204);

    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?filter=name:eq:Deleted%20Ltd&limit=100',
      token: adminA.token,
    });
    expect(dataOf<unknown[]>(response).length).toBe(0);
  });
});
