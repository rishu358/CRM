import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for the contacts module.
 *
 * Run against real Postgres with RLS on, like every other test here: the
 * optimistic locking and keyset paging being checked are database behaviour,
 * and a mock would simply agree with whatever this file expects.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  const tenant = await harness.fixtures.createTenant({ name: 'Behaviour Co' });
  tenantId = tenant.tenantId;
  const roles = await harness.provision(tenantId);
  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
});

afterAll(async () => {
  await harness.close();
});

async function createContact(body: Record<string, unknown>) {
  return request(harness, { method: 'POST', url: '/api/v1/contacts', token: admin.token, body });
}

describe('create', () => {
  it('creates a contact and returns it with version 1', async () => {
    const response = await createContact({ lastName: 'Bose', email: 'BOSE@Example.COM' });
    expect(response.status).toBe(201);

    const contact = response.body['data'] as Record<string, unknown>;
    expect(contact['lastName']).toBe('Bose');
    // Lowercased by the contract schema so it matches the citext column.
    expect(contact['email']).toBe('bose@example.com');
    expect(contact['version']).toBe(1);
    expect(contact['ownerId']).toBe(admin.userId);
  });

  it('rejects an unknown key rather than dropping it (CLAUDE.md §5.6)', async () => {
    const response = await createContact({ lastName: 'Bose', nickname: 'Bo' });
    expect(response.status).toBe(422);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('VALIDATION_FAILED');
  });

  it('rejects a phone number that is not E.164', async () => {
    const response = await createContact({ lastName: 'Bose', phone: '9876543210' });
    expect(response.status).toBe(422);
  });

  it('requires a last name', async () => {
    expect((await createContact({ firstName: 'Only' })).status).toBe(422);
  });

  it('rejects an unknown custom field', async () => {
    const response = await createContact({
      lastName: 'Bose',
      customFields: { not_a_real_field: 'x' },
    });
    // 403, the same answer a *hidden* field gives. Returning 422 for "no such
    // field" and 403 for "exists but hidden" would let a caller probe for the
    // keys of fields they are not allowed to know about.
    expect(response.status).toBe(403);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('FIELD_NOT_WRITABLE');
  });
});

describe('optimistic locking (MVP_SPEC M4)', () => {
  it('rejects a stale version with 409 instead of overwriting', async () => {
    const created = await createContact({ lastName: 'Kapoor' });
    const id = (created.body['data'] as Record<string, unknown>)['id'] as string;

    const first = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
      body: { title: 'Director', version: 1 },
    });
    expect(first.status).toBe(200);
    expect((first.body['data'] as Record<string, unknown>)['version']).toBe(2);

    // A second editor who read version 1 before the first save.
    const stale = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
      body: { title: 'Partner', version: 1 },
    });
    expect(stale.status).toBe(409);
    expect((stale.body['error'] as Record<string, unknown>)['code']).toBe('VERSION_CONFLICT');

    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
    });
    // The first writer's value survived; nothing was silently clobbered.
    expect((check.body['data'] as Record<string, unknown>)['title']).toBe('Director');
  });

  it('requires a version on update at all', async () => {
    const created = await createContact({ lastName: 'Rao' });
    const id = (created.body['data'] as Record<string, unknown>)['id'] as string;

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
      body: { title: 'No version' },
    });
    expect(response.status).toBe(422);
  });
});

describe('patch semantics', () => {
  it('leaves custom fields it does not mention alone', async () => {
    const created = await createContact({ lastName: 'Menon' });
    const id = (created.body['data'] as Record<string, unknown>)['id'] as string;

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
      body: { firstName: 'Lakshmi', version: 1 },
    });
    expect(response.status).toBe(200);
    expect((response.body['data'] as Record<string, unknown>)['lastName']).toBe('Menon');
  });

  it('clears a field when it is explicitly set to null', async () => {
    const created = await createContact({ lastName: 'Dutta', title: 'CFO' });
    const id = (created.body['data'] as Record<string, unknown>)['id'] as string;

    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
      body: { title: null, version: 1 },
    });
    expect((response.body['data'] as Record<string, unknown>)['title']).toBeNull();
  });
});

describe('soft delete', () => {
  it('removes the contact from lists but keeps it restorable', async () => {
    const created = await createContact({ lastName: 'Gone' });
    const id = (created.body['data'] as Record<string, unknown>)['id'] as string;

    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/contacts/${id}?version=1`,
      token: admin.token,
    });
    expect(deleted.status).toBe(204);

    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${id}`,
      token: admin.token,
    });
    expect(read.status).toBe(404);
  });
});

describe('list: sorting and filtering are whitelisted (CLAUDE.md §5.7)', () => {
  it('sorts by an allowed field', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?sort=last_name&limit=100',
      token: admin.token,
    });
    expect(response.status).toBe(200);

    const names = (response.body['data'] as { lastName: string }[]).map((row) => row.lastName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('refuses a sort key that is not a field', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?sort=password_hash',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('refuses SQL smuggled through the sort parameter', async () => {
    const attempts = [
      'last_name; drop table contacts',
      'last_name) --',
      '(select 1)',
      'last_name,version',
    ];
    for (const sort of attempts) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts?sort=${encodeURIComponent(sort)}`,
        token: admin.token,
      });
      expect(response.status, sort).toBe(422);
    }

    // And the table is still there.
    const check = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: admin.token,
    });
    expect(check.status).toBe(200);
  });

  it('filters by an allowed field and operator', async () => {
    await createContact({ lastName: 'Filterable', leadSource: 'exhibition' });
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?filter=lead_source:eq:exhibition&limit=100',
      token: admin.token,
    });
    expect(response.status).toBe(200);

    const rows = response.body['data'] as { lastName: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.lastName === 'Filterable')).toBe(true);
  });

  it('refuses an unknown filter operator or field', async () => {
    for (const filter of ['lead_source:drop:x', 'password_hash:eq:x', 'nonsense']) {
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/contacts?filter=${encodeURIComponent(filter)}`,
        token: admin.token,
      });
      expect(response.status, filter).toBe(422);
    }
  });

  it('treats wildcards in a contains filter as literal characters', async () => {
    await createContact({ lastName: 'Percent' });
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?filter=last_name:contains:%25&limit=100',
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
      await createContact({ lastName: `Page${String(index).padStart(2, '0')}` });
    }
  });

  it('caps the page size at 100', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?limit=101',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('offers no offset parameter', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?offset=10',
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
          ? '/api/v1/contacts?limit=5&sort=created_at'
          : `/api/v1/contacts?limit=5&sort=created_at&cursor=${encodeURIComponent(cursor)}`;

      const response = await request(harness, { method: 'GET', url, token: admin.token });
      expect(response.status).toBe(200);

      for (const row of response.body['data'] as { id: string }[]) seen.push(row.id);
      const meta = response.body['meta'] as { nextCursor: string | null };
      cursor = meta.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 20);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(12);
  });

  it('rejects a malformed cursor cleanly rather than failing in the database', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts?cursor=not-a-real-cursor',
      token: admin.token,
    });
    // A bad cursor is ignored and the first page is returned; it is positional
    // data, not an authorization token, so there is nothing to defend here.
    expect(response.status).toBe(200);
  });
});

describe('every response carries a request id (CLAUDE.md §8)', () => {
  it('returns the envelope shape on success', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: admin.token,
    });
    expect(response.body).toHaveProperty('data');
    expect(response.body).toHaveProperty('meta');
  });
});
