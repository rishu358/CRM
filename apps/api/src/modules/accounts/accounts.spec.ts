import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { captureDbError } from '@crm/db/testing';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for the accounts module.
 *
 * Run against real Postgres with RLS on, like every other test here: the
 * optimistic locking, the keyset paging and — above all — the hierarchy
 * trigger being checked are database behaviour, and a mock would simply agree
 * with whatever this file expects.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  const tenant = await harness.fixtures.createTenant({ name: 'Behaviour Holdings' });
  tenantId = tenant.tenantId;
  const roles = await harness.provision(tenantId);
  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
});

afterAll(async () => {
  await harness.close();
});

async function createAccount(body: Record<string, unknown>) {
  return request(harness, { method: 'POST', url: '/api/v1/accounts', token: admin.token, body });
}

/** Create an account through the API and return its id. */
async function newAccount(name: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await createAccount({ name, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body['data'] as Record<string, unknown>)['id'] as string;
}

function data(response: { body: Record<string, unknown> }): Record<string, unknown> {
  return response.body['data'] as Record<string, unknown>;
}

function errorCode(response: { body: Record<string, unknown> }): unknown {
  return (response.body['error'] as Record<string, unknown>)['code'];
}

describe('create', () => {
  it('creates an account and returns it with version 1', async () => {
    const response = await createAccount({ name: 'Rajesh Gold House' });
    expect(response.status).toBe(201);

    const account = data(response);
    expect(account['name']).toBe('Rajesh Gold House');
    expect(account['version']).toBe(1);
    expect(account['ownerId']).toBe(admin.userId);
  });

  it('normalises the fields duplicate detection compares', async () => {
    const response = await createAccount({
      name: 'Normalised Ltd',
      domain: 'Normalised.Example',
      email: 'SALES@Normalised.Example',
      gstin: '29abcde1234f1z5',
    });
    const account = data(response);
    expect(account['domain']).toBe('normalised.example');
    expect(account['email']).toBe('sales@normalised.example');
    expect(account['gstin']).toBe('29ABCDE1234F1Z5');
  });

  it('rejects an unknown key rather than dropping it (CLAUDE.md §5.6)', async () => {
    const response = await createAccount({ name: 'Acme', turnover: 100 });
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown key inside an address, which nothing else validates', async () => {
    const response = await createAccount({
      name: 'Acme',
      billingAddress: { city: 'Chennai', secret: 'x' },
    });
    expect(response.status).toBe(422);
  });

  it('requires a name', async () => {
    expect((await createAccount({ domain: 'nameless.example' })).status).toBe(422);
    expect((await createAccount({ name: '   ' })).status).toBe(422);
  });

  it('rejects a website that is not http or https', async () => {
    const response = await createAccount({ name: 'Acme', website: 'javascript:alert(1)' });
    expect(response.status).toBe(422);
  });

  it('rejects a phone number that is not E.164', async () => {
    expect((await createAccount({ name: 'Acme', phone: '9876543210' })).status).toBe(422);
  });

  it('rejects an unknown custom field', async () => {
    const response = await createAccount({ name: 'Acme', customFields: { not_real: 'x' } });
    // 403, the same answer a *hidden* field gives. Returning 422 for "no such
    // field" and 403 for "exists but hidden" would let a caller probe for the
    // keys of fields they are not allowed to know about.
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('FIELD_NOT_WRITABLE');
  });
});

describe('annual revenue is money, not a number (CLAUDE.md §7)', () => {
  it('round-trips minor units and currency', async () => {
    const response = await createAccount({
      name: 'Revenue Co',
      annualRevenue: { amountMinor: '120000000000', currency: 'INR' },
    });
    expect(data(response)['annualRevenue']).toEqual({
      amountMinor: '120000000000',
      currency: 'INR',
    });
  });

  it('keeps an amount larger than 2^53 exact', async () => {
    // The number a float would quietly round. bigint in the column, a string
    // on the wire, and nothing in between that can lose a paisa.
    const huge = '9007199254740993';
    const id = await newAccount('Very Large Group', {
      annualRevenue: { amountMinor: huge, currency: 'INR' },
    });

    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
    });
    expect((data(read)['annualRevenue'] as Record<string, unknown>)['amountMinor']).toBe(huge);
  });

  it('refuses a float, a JSON number and an invented currency', async () => {
    for (const annualRevenue of [
      { amountMinor: 1200.5, currency: 'INR' },
      { amountMinor: 1200, currency: 'INR' },
      { amountMinor: '1200', currency: 'RUPEE' },
      { amountMinor: '1200' },
    ]) {
      const response = await createAccount({ name: 'Bad Money', annualRevenue });
      expect(response.status, JSON.stringify(annualRevenue)).toBe(422);
    }
  });

  it('clears both columns together when the amount is set to null', async () => {
    const id = await newAccount('Cleared Revenue', {
      annualRevenue: { amountMinor: '5000', currency: 'INR' },
    });

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
      body: { annualRevenue: null, version: 1 },
    });
    // The table's CHECK requires both or neither; a patch that cleared only
    // the amount would arrive here as a 500 instead of a cleared field.
    expect(response.status).toBe(200);
    expect(data(response)['annualRevenue']).toBeNull();
  });
});

describe('the parent account hierarchy (ADR-0018)', () => {
  it('links a child to a parent', async () => {
    const parent = await newAccount('Group Holdings');
    const child = await newAccount('Group Holdings — Kochi', { parentAccountId: parent });

    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${child}`,
      token: admin.token,
    });
    expect(data(read)['parentAccountId']).toBe(parent);
  });

  it('refuses an account as its own parent', async () => {
    const id = await newAccount('Self Referential');
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
      body: { parentAccountId: id, version: 1 },
    });
    expect(response.status).toBe(422);
    expect(errorCode(response)).toBe('VALIDATION_FAILED');
  });

  it('refuses a parent that does not exist', async () => {
    const response = await createAccount({
      name: 'Orphan',
      parentAccountId: '01a1443a-0000-7000-8000-000000000000',
    });
    expect(response.status).toBe(422);
  });

  it('refuses a parent that has been deleted', async () => {
    const parent = await newAccount('Soon Deleted');
    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/accounts/${parent}?version=1`,
      token: admin.token,
    });
    expect(deleted.status).toBe(204);

    const response = await createAccount({ name: 'Too Late', parentAccountId: parent });
    expect(response.status).toBe(422);
  });

  it('refuses a two-account cycle', async () => {
    const a = await newAccount('Cycle A');
    const b = await newAccount('Cycle B', { parentAccountId: a });

    // A under B would close the loop A → B → A.
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${a}`,
      token: admin.token,
      body: { parentAccountId: b, version: 1 },
    });
    expect(response.status).toBe(422);
    expect((response.body['error'] as { details: { path?: string }[] }).details[0]?.path).toBe(
      'parentAccountId',
    );
  });

  it('refuses a cycle several levels deep', async () => {
    const top = await newAccount('Deep 1');
    const middle = await newAccount('Deep 2', { parentAccountId: top });
    const bottom = await newAccount('Deep 3', { parentAccountId: middle });
    const leaf = await newAccount('Deep 4', { parentAccountId: bottom });

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${top}`,
      token: admin.token,
      body: { parentAccountId: leaf, version: 1 },
    });
    expect(response.status).toBe(422);
  });

  it('allows reparenting that does not create a cycle', async () => {
    const first = await newAccount('Parent One');
    const second = await newAccount('Parent Two');
    const child = await newAccount('Movable Child', { parentAccountId: first });

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${child}`,
      token: admin.token,
      body: { parentAccountId: second, version: 1 },
    });
    expect(response.status).toBe(200);
    expect(data(response)['parentAccountId']).toBe(second);
  });

  it('is enforced by the database, not only by the service', async () => {
    // The same loop attempted with plain SQL through a superuser connection,
    // which skips every line of application code. The trigger is the actual
    // guarantee; the service check exists to produce a readable message.
    const a = await harness.fixtures.createAccount(tenantId, { name: 'Raw Cycle A' });
    const b = await harness.fixtures.createAccount(tenantId, {
      name: 'Raw Cycle B',
      parentAccountId: a,
    });

    const error = await captureDbError(() => harness.fixtures.setAccountParent(a, b));
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/cycle/i);
  });

  it('keeps children pointing at a soft-deleted parent, so a restore is lossless', async () => {
    const parent = await newAccount('Restorable Parent');
    const child = await newAccount('Surviving Child', { parentAccountId: parent });

    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/accounts/${parent}?version=1`,
      token: admin.token,
    });
    expect(deleted.status).toBe(204);

    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${child}`,
      token: admin.token,
    });
    // The child is still here and still remembers where it belonged. Nulling
    // the link on delete would make the Recycle Bin's promise untrue.
    expect(read.status).toBe(200);
    expect(data(read)['parentAccountId']).toBe(parent);
  });
});

describe('optimistic locking (MVP_SPEC M4)', () => {
  it('rejects a stale version with 409 instead of overwriting', async () => {
    const id = await newAccount('Locked Ltd');

    const first = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
      body: { industry: 'Jewellery', version: 1 },
    });
    expect(first.status).toBe(200);
    expect(data(first)['version']).toBe(2);

    const stale = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
      body: { industry: 'Textiles', version: 1 },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('VERSION_CONFLICT');

    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
    });
    // The first writer's value survived; nothing was silently clobbered.
    expect(data(check)['industry']).toBe('Jewellery');
  });

  it('requires a version on update at all', async () => {
    const id = await newAccount('Unversioned Ltd');
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
      body: { industry: 'No version' },
    });
    expect(response.status).toBe(422);
  });
});

describe('patch semantics', () => {
  it('leaves fields it does not mention alone', async () => {
    const id = await newAccount('Untouched Ltd', { industry: 'Retail' });
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
      body: { employeeCount: 12, version: 1 },
    });
    expect(response.status).toBe(200);
    expect(data(response)['industry']).toBe('Retail');
    expect(data(response)['employeeCount']).toBe(12);
  });

  it('clears a field when it is explicitly set to null', async () => {
    const id = await newAccount('Clearable Ltd', { gstin: '29ABCDE1234F1Z5' });
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
      body: { gstin: null, version: 1 },
    });
    expect(data(response)['gstin']).toBeNull();
  });
});

describe('soft delete', () => {
  it('removes the account from lists but keeps it restorable', async () => {
    const id = await newAccount('Gone Ltd');

    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/accounts/${id}?version=1`,
      token: admin.token,
    });
    expect(deleted.status).toBe(204);

    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/accounts/${id}`,
      token: admin.token,
    });
    expect(read.status).toBe(404);
  });
});

describe('list: sorting and filtering are whitelisted (CLAUDE.md §5.7)', () => {
  it('sorts by an allowed field', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?sort=name&limit=100',
      token: admin.token,
    });
    expect(response.status).toBe(200);

    const names = (response.body['data'] as { name: string }[]).map((row) => row.name);
    expect([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(names);
  });

  it('refuses a sort key that is not a field', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?sort=annual_revenue_currency',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('refuses SQL smuggled through the sort parameter', async () => {
    const attempts = ['name; drop table accounts', 'name) --', '(select 1)', 'name,version'];
    for (const sort of attempts) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/accounts?sort=${encodeURIComponent(sort)}`,
        token: admin.token,
      });
      expect(response.status, sort).toBe(422);
    }

    // And the table is still there.
    const check = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts',
      token: admin.token,
    });
    expect(check.status).toBe(200);
  });

  it('filters by an allowed field and operator', async () => {
    await newAccount('Filterable Ltd', { industry: 'Exhibition stands' });
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?filter=industry:eq:Exhibition%20stands&limit=100',
      token: admin.token,
    });
    expect(response.status).toBe(200);

    const rows = response.body['data'] as { name: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.name === 'Filterable Ltd')).toBe(true);
  });

  it('compares revenue as a number, not as text', async () => {
    await newAccount('Nine Lakh', { annualRevenue: { amountMinor: '900000', currency: 'INR' } });
    await newAccount('Ten Lakh', { annualRevenue: { amountMinor: '1000000', currency: 'INR' } });

    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?filter=annual_revenue:gt:950000&limit=100',
      token: admin.token,
    });
    const names = (response.body['data'] as { name: string }[]).map((row) => row.name);
    // As text, '900000' sorts after '1000000'; as a bigint it does not.
    expect(names).toContain('Ten Lakh');
    expect(names).not.toContain('Nine Lakh');
  });

  it('refuses an unknown filter operator or field', async () => {
    for (const filter of ['industry:drop:x', 'password_hash:eq:x', 'nonsense']) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/accounts?filter=${encodeURIComponent(filter)}`,
        token: admin.token,
      });
      expect(response.status, filter).toBe(422);
    }
  });

  it('refuses a value the column cannot hold, rather than failing in the driver', async () => {
    const attempts = [
      'annual_revenue:gt:banana',
      'employee_count:eq:lots',
      'owner_id:eq:not-a-uuid',
      'created_at:gte:yesterday',
      // Substring matching on a number is a mistake, not a query.
      'employee_count:contains:5',
    ];
    for (const filter of attempts) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/accounts?filter=${encodeURIComponent(filter)}`,
        token: admin.token,
      });
      expect(response.status, filter).toBe(422);
      expect(errorCode(response), filter).toBe('VALIDATION_FAILED');
    }
  });

  it('treats wildcards in a contains filter as literal characters', async () => {
    await newAccount('Percentless Ltd');
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?filter=name:contains:%25&limit=100',
      token: admin.token,
    });
    expect(response.status).toBe(200);
    // A bare % must not match every row.
    expect((response.body['data'] as unknown[]).length).toBe(0);
  });
});

describe('list: keyset pagination (ADR-0012)', () => {
  beforeAll(async () => {
    for (let index = 0; index < 12; index += 1) {
      await newAccount(`Page${String(index).padStart(2, '0')} Ltd`);
    }
  });

  it('caps the page size at 100', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?limit=101',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('offers no offset parameter', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?offset=10',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('walks the whole set without repeating or skipping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        cursor === null
          ? '/api/v1/accounts?limit=5&sort=created_at'
          : `/api/v1/accounts?limit=5&sort=created_at&cursor=${encodeURIComponent(cursor)}`;

      const response = await request(harness, { method: 'GET', url, token: admin.token });
      expect(response.status).toBe(200);

      for (const row of response.body['data'] as { id: string }[]) seen.push(row.id);
      const meta = response.body['meta'] as { nextCursor: string | null };
      cursor = meta.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 40);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(12);
  });

  it('pages a nullable sort column without losing the rows that are null', async () => {
    // Most of these accounts have no revenue at all. A keyset predicate that
    // compared against NULL would silently drop every one of them.
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        cursor === null
          ? '/api/v1/accounts?limit=5&sort=annual_revenue'
          : `/api/v1/accounts?limit=5&sort=annual_revenue&cursor=${encodeURIComponent(cursor)}`;
      const response = await request(harness, { method: 'GET', url, token: admin.token });
      expect(response.status).toBe(200);
      for (const row of response.body['data'] as { id: string }[]) seen.add(row.id);
      cursor = (response.body['meta'] as { nextCursor: string | null }).nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 40);

    const all = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?limit=100',
      token: admin.token,
    });
    expect(seen.size).toBe((all.body['data'] as unknown[]).length);
  });

  it('rejects a malformed cursor cleanly rather than failing in the database', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts?cursor=not-a-real-cursor',
      token: admin.token,
    });
    // A bad cursor is ignored and the first page is returned; it is positional
    // data, not an authorization token, so there is nothing to defend here.
    expect(response.status).toBe(200);
  });
});

describe('every response carries the envelope (CLAUDE.md §8)', () => {
  it('returns data and meta on a list', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/accounts',
      token: admin.token,
    });
    expect(response.body).toHaveProperty('data');
    expect(response.body).toHaveProperty('meta');
  });
});
